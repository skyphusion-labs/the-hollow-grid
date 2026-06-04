import { DurableObject } from "cloudflare:workers";
import type { Env, Session } from "./types";
import { ROOMS, START_ROOM, HOLDING_PIT, WARDEN_ID, TAVERN, MARKET, normalizeDir } from "./rooms";
import { MOB_TEMPLATES, MOB_BY_ID } from "./mobs";
import { ITEM_TEMPLATES, itemMatches } from "./items";

const NL = "\r\n"; // wscat / telnet-style clients render CRLF cleanly

const ROUND_MS = 3_000; // combat + poison resolve one tick every 3 seconds
const BASE_HP = 30;
const POISON_DMG = 1; // hp lost per tick while poisoned

type MobRow = {
  id: string;
  room: string;
  hp: number;
  max_hp: number;
  state: "alive" | "dead";
  respawn_at: number;
};

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * World: a single Durable Object that holds the whole game. Players route to
 * the same instance via `getByName("world")` and share one coordinated world.
 *
 * Connections use the WebSocket Hibernation API; per-player state rides on the
 * socket attachment. A DO **alarm** drives all time-based mechanics: combat
 * rounds, mob respawns, and poison ticks. The alarm reschedules only while
 * something is pending (a fight, a respawn, or a poisoned player), then lets the
 * DO hibernate. All durable state (mobs, player vitals, inventories, ground
 * items) lives in SQLite, so ticks still work after the DO is evicted.
 */
export class World extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;

      sql.exec(`
        CREATE TABLE IF NOT EXISTS players (
          name TEXT PRIMARY KEY,
          room TEXT NOT NULL,
          hp INTEGER NOT NULL DEFAULT ${BASE_HP},
          max_hp INTEGER NOT NULL DEFAULT ${BASE_HP},
          xp INTEGER NOT NULL DEFAULT 0,
          level INTEGER NOT NULL DEFAULT 1,
          poisoned INTEGER NOT NULL DEFAULT 0,
          gold INTEGER NOT NULL DEFAULT 0,
          morality INTEGER NOT NULL DEFAULT 0,
          addiction INTEGER NOT NULL DEFAULT 0,
          faction TEXT NOT NULL DEFAULT 'none',
          resisted INTEGER NOT NULL DEFAULT 0
        )
      `);
      for (const col of [
        `hp INTEGER NOT NULL DEFAULT ${BASE_HP}`,
        `max_hp INTEGER NOT NULL DEFAULT ${BASE_HP}`,
        "xp INTEGER NOT NULL DEFAULT 0",
        "level INTEGER NOT NULL DEFAULT 1",
        "poisoned INTEGER NOT NULL DEFAULT 0",
        "gold INTEGER NOT NULL DEFAULT 0",
        "morality INTEGER NOT NULL DEFAULT 0",
        "addiction INTEGER NOT NULL DEFAULT 0",
        "faction TEXT NOT NULL DEFAULT 'none'",
        "resisted INTEGER NOT NULL DEFAULT 0",
      ]) {
        try {
          sql.exec(`ALTER TABLE players ADD COLUMN ${col}`);
        } catch {
          // column already exists
        }
      }

      sql.exec(`
        CREATE TABLE IF NOT EXISTS mobs (
          id TEXT PRIMARY KEY,
          room TEXT NOT NULL,
          hp INTEGER NOT NULL,
          max_hp INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'alive',
          respawn_at INTEGER NOT NULL DEFAULT 0
        )
      `);
      for (const t of MOB_TEMPLATES) {
        sql.exec(
          "INSERT OR IGNORE INTO mobs (id, room, hp, max_hp, state, respawn_at) VALUES (?, ?, ?, ?, 'alive', 0)",
          t.template,
          t.room,
          t.maxHp,
          t.maxHp,
        );
      }

      // Items: per-player inventory and per-room ground piles.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS inventory (
          player TEXT NOT NULL,
          item TEXT NOT NULL,
          qty INTEGER NOT NULL,
          PRIMARY KEY (player, item)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS ground (
          room TEXT NOT NULL,
          item TEXT NOT NULL,
          qty INTEGER NOT NULL,
          PRIMARY KEY (room, item)
        )
      `);
    });
  }

  // ---- connection lifecycle ------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("This endpoint speaks WebSocket. Try `wscat -c <url>/ws`.", {
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const session: Session = {
      name: "",
      room: "",
      hp: BASE_HP,
      maxHp: BASE_HP,
      xp: 0,
      level: 1,
      target: null,
      poisoned: false,
      gold: 0,
      morality: 0,
      addiction: 0,
      faction: "none",
      resisted: false,
    };
    server.serializeAttachment(session);

    server.send(
      [
        "",
        "================================================================",
        "  THE CHROME WASTES: a MUD on Cloudflare Workers",
        "================================================================",
        "",
        "By what name are you known, wanderer?",
      ].join(NL) + NL,
    );

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const line = (typeof message === "string" ? message : new TextDecoder().decode(message)).trim();
    const session = ws.deserializeAttachment() as Session | null;

    if (!session || !session.name) {
      this.handleLogin(ws, line);
      return;
    }
    await this.handleCommand(ws, session, line);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const session = ws.deserializeAttachment() as Session | null;
    if (session?.name) {
      this.broadcast(session.room, `${session.name} flickers out of existence.`, ws);
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  // ---- alarm: combat + respawns + poison ----------------------------------

  async alarm(): Promise<void> {
    const now = Date.now();

    // 1) Respawn due mobs.
    const due = this.ctx.storage.sql
      .exec<MobRow>("SELECT * FROM mobs WHERE state = 'dead' AND respawn_at <= ?", now)
      .toArray();
    for (const m of due) {
      this.ctx.storage.sql.exec("UPDATE mobs SET state = 'alive', hp = max_hp WHERE id = ?", m.id);
      this.broadcast(m.room, `${cap(MOB_BY_ID[m.id].name)} stalks into view.`);
    }

    // 2) Poison ticks (in or out of combat).
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (!s?.name || !s.poisoned) continue;
      s.hp = Math.max(0, s.hp - POISON_DMG);
      if (s.hp <= 0) {
        this.line(ws, "The venom finishes what the wastes started...");
        this.killPlayer(ws, s);
        continue;
      }
      this.line(ws, `The venom gnaws at you. (HP ${s.hp}/${s.maxHp})`);
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.prompt(ws);
    }

    // 3) Combat rounds. Deserialize per ws so kills/deaths this tick are seen.
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.target) this.resolveRound(ws, s);
    }

    await this.scheduleNextTick();
  }

  /** Schedule the next alarm only if there's combat, a respawn, or poison. */
  private async scheduleNextTick(): Promise<void> {
    const now = Date.now();
    let next = Infinity;

    const busy = this.ctx
      .getWebSockets()
      .some((ws) => {
        const s = ws.deserializeAttachment() as Session | null;
        return !!s && (!!s.target || s.poisoned);
      });
    if (busy) next = Math.min(next, now + ROUND_MS);

    const soonest = this.ctx.storage.sql
      .exec<{ t: number | null }>("SELECT MIN(respawn_at) AS t FROM mobs WHERE state = 'dead'")
      .one();
    if (soonest.t != null) next = Math.min(next, Math.max(soonest.t, now + 100));

    if (next === Infinity) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private resolveRound(ws: WebSocket, s: Session): void {
    const mob = this.loadMob(s.target!);
    const t = mob ? MOB_BY_ID[mob.id] : undefined;

    if (!mob || !t || mob.state === "dead" || mob.room !== s.room) {
      s.target = null;
      ws.serializeAttachment(s);
      this.line(ws, "Your quarry is gone. You stand down.");
      this.prompt(ws);
      return;
    }

    // Player strikes first.
    const pdmg = rand(3, 7) + (s.level - 1) * 2;
    const mobHp = Math.max(0, mob.hp - pdmg);
    this.ctx.storage.sql.exec("UPDATE mobs SET hp = ? WHERE id = ?", mobHp, mob.id);
    this.line(ws, `You hit ${t.name} for ${pdmg}. (${mobHp}/${mob.max_hp})`);

    if (mobHp <= 0) {
      this.killMob(ws, s, mob, t);
      return;
    }

    // Mob hits back, possibly envenomating.
    const mdmg = rand(t.minDmg, t.maxDmg);
    s.hp = Math.max(0, s.hp - mdmg);
    this.line(ws, `${cap(t.name)} hits you for ${mdmg}. (HP ${s.hp}/${s.maxHp})`);

    if (s.hp <= 0) {
      this.killPlayer(ws, s);
      return;
    }

    if (t.poisonChance && !s.poisoned && Math.random() < t.poisonChance) {
      s.poisoned = true;
      this.line(ws, "Venom courses through your veins; you are POISONED. Seek an antidote.");
    }

    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private killMob(ws: WebSocket, s: Session, mob: MobRow, t: (typeof MOB_TEMPLATES)[number]): void {
    this.ctx.storage.sql.exec(
      "UPDATE mobs SET state = 'dead', hp = 0, respawn_at = ? WHERE id = ?",
      Date.now() + t.respawnMs,
      mob.id,
    );
    this.line(ws, `You have slain ${t.name}!  (+${t.xp} xp)`);
    this.broadcast(mob.room, `${s.name} has slain ${t.name}.`, ws);

    // Roll loot onto the ground.
    for (const drop of t.loot ?? []) {
      if (Math.random() < drop.chance) {
        this.groundAdd(mob.room, drop.item, 1);
        const name = ITEM_TEMPLATES[drop.item].name;
        this.line(ws, `${cap(t.name)} drops ${name}.`);
        this.broadcast(mob.room, `${cap(t.name)} drops ${name}.`, ws);
      }
    }

    // Anyone else fighting this mob loses their target.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const os = other.deserializeAttachment() as Session | null;
      if (os?.target === mob.id) {
        os.target = null;
        other.serializeAttachment(os);
        this.line(other, `${cap(t.name)} falls before you can finish it.`);
        this.prompt(other);
      }
    }

    s.target = null;
    this.awardXp(ws, s, t.xp);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private killPlayer(ws: WebSocket, s: Session): void {
    this.line(ws, "Your vision whites out and you crumple into the dust...");
    this.broadcast(s.room, `${s.name} collapses, lifeless.`, ws);

    s.target = null;
    s.poisoned = false; // death burns the venom out
    s.room = START_ROOM;
    s.hp = s.maxHp;
    ws.serializeAttachment(s);
    this.persistPlayer(s);

    this.line(ws, "...and wake, gasping, back at The Cracked Nexus.");
    this.broadcast(START_ROOM, `${s.name} staggers in, pale and shaking.`, ws);
    ws.send(this.describeRoom(s));
    this.prompt(ws);
  }

  private awardXp(ws: WebSocket, s: Session, amount: number): void {
    s.xp += amount;
    while (s.xp >= s.level * 100) {
      s.xp -= s.level * 100;
      s.level += 1;
      s.maxHp += 10;
      s.hp = s.maxHp;
      this.line(ws, `*** You reach level ${s.level}! Max HP is now ${s.maxHp}. ***`);
    }
  }

  // ---- login ---------------------------------------------------------------

  private handleLogin(ws: WebSocket, raw: string): void {
    const name = raw.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16);
    if (name.length < 2) {
      ws.send("Names must be 2-16 characters (letters, numbers, underscore)." + NL + "Your name? ");
      return;
    }
    if (this.isNameOnline(name)) {
      ws.send(`Someone is already wearing the name "${name}". Choose another.` + NL + "Your name? ");
      return;
    }

    const row = this.ctx.storage.sql
      .exec<{
        room: string;
        hp: number;
        max_hp: number;
        xp: number;
        level: number;
        poisoned: number;
        gold: number;
        morality: number;
        addiction: number;
        faction: string;
        resisted: number;
      }>(
        "SELECT room, hp, max_hp, xp, level, poisoned, gold, morality, addiction, faction, resisted FROM players WHERE name = ?",
        name,
      )
      .toArray()[0];

    let room = row?.room ?? START_ROOM;
    if (!ROOMS[room]) room = START_ROOM;

    const session: Session = {
      name,
      room,
      hp: row?.hp ?? BASE_HP,
      maxHp: row?.max_hp ?? BASE_HP,
      xp: row?.xp ?? 0,
      level: row?.level ?? 1,
      target: null,
      poisoned: !!row?.poisoned,
      gold: row?.gold ?? 0,
      morality: row?.morality ?? 0,
      addiction: row?.addiction ?? 0,
      faction: (row?.faction as Session["faction"]) ?? "none",
      resisted: !!row?.resisted,
    };
    if (session.hp <= 0) session.hp = session.maxHp;
    ws.serializeAttachment(session);
    this.persistPlayer(session);

    ws.send(`Welcome to the wastes, ${name}.` + NL);
    this.broadcast(room, `${name} steps out of the haze.`, ws);
    ws.send(this.describeRoom(session));
    if (session.poisoned) this.line(ws, "The old venom still burns in you. (poisoned)");
    this.prompt(ws);
    if (session.poisoned) void this.scheduleNextTick();
  }

  // ---- command handling ----------------------------------------------------

  private async handleCommand(ws: WebSocket, s: Session, line: string): Promise<void> {
    if (line.length === 0) {
      this.prompt(ws);
      return;
    }

    const [word, ...rest] = line.split(/\s+/);
    const cmd = word.toLowerCase();
    const arg = rest.join(" ");

    const dir = normalizeDir(cmd);
    if (dir) {
      await this.move(ws, s, dir);
      return;
    }

    switch (cmd) {
      case "look":
      case "l":
        ws.send(this.describeRoom(s));
        this.prompt(ws);
        break;
      case "go":
        await this.handleGo(ws, s, arg);
        break;
      case "attack":
      case "kill":
      case "k":
        await this.attack(ws, s, arg);
        break;
      case "flee":
      case "f":
        this.flee(ws, s);
        break;
      case "get":
      case "take":
        this.get(ws, s, arg);
        break;
      case "drop":
        this.drop(ws, s, arg);
        break;
      case "inventory":
      case "inv":
      case "i":
        ws.send(this.inventoryView(s));
        this.prompt(ws);
        break;
      case "use":
      case "drink":
      case "eat":
        await this.use(ws, s, arg);
        break;
      case "examine":
      case "exa":
        this.examine(ws, s, arg);
        break;
      case "free":
      case "rescue":
        this.freeMaiden(ws, s);
        break;
      case "sell":
        this.sell(ws, s, arg);
        break;
      case "steal":
        await this.steal(ws, s);
        break;
      case "buy":
        this.buy(ws, s, arg);
        break;
      case "carouse":
        await this.carouse(ws, s);
        break;
      case "resist":
      case "refuse":
        this.resist(ws, s);
        break;
      case "join":
        this.factionChoice(ws, s, "front");
        break;
      case "defend":
      case "defy":
      case "oppose":
        this.factionChoice(ws, s, "ally");
        break;
      case "talk":
      case "ask":
        this.talk(ws, s);
        break;
      case "hp":
      case "status":
      case "st":
        this.statusView(ws, s);
        this.prompt(ws);
        break;
      case "say":
      case "'":
        this.say(ws, s, arg);
        this.prompt(ws);
        break;
      case "who":
        ws.send(this.who());
        this.prompt(ws);
        break;
      case "help":
      case "?":
        ws.send(this.help());
        this.prompt(ws);
        break;
      case "quit":
        ws.send("You step back into the haze. Stay alive out there." + NL);
        this.broadcast(s.room, `${s.name} flickers out of existence.`, ws);
        ws.close(1000, "quit");
        break;
      default:
        this.line(ws, `I don't understand "${cmd}". Try "help".`);
        this.prompt(ws);
        break;
    }
  }

  private async handleGo(ws: WebSocket, s: Session, arg: string): Promise<void> {
    const dir = normalizeDir(arg);
    if (!dir) {
      this.line(ws, 'Go where? Try a direction like "go north".');
      this.prompt(ws);
      return;
    }
    await this.move(ws, s, dir);
  }

  private async move(ws: WebSocket, s: Session, dir: string): Promise<void> {
    const room = ROOMS[s.room];
    const destId = room.exits[dir];
    if (!destId) {
      this.line(ws, `You can't go ${dir} from here.`);
      this.prompt(ws);
      return;
    }

    if (s.target) {
      s.target = null;
      this.line(ws, "You disengage and slip away.");
    }

    this.broadcast(s.room, `${s.name} heads ${dir}.`, ws);
    s.room = destId;
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.broadcast(destId, `${s.name} arrives.`, ws);
    ws.send(this.describeRoom(s));
    this.prompt(ws);
  }

  private async attack(ws: WebSocket, s: Session, arg: string): Promise<void> {
    if (!arg) {
      this.line(ws, "Attack what?");
      this.prompt(ws);
      return;
    }
    const mob = this.livingMobsInRoom(s.room).find((m) => this.mobMatches(m.id, arg));
    if (!mob) {
      this.line(ws, `There's nothing like "${arg}" to fight here.`);
      this.prompt(ws);
      return;
    }
    const t = MOB_BY_ID[mob.id];
    s.target = mob.id;
    ws.serializeAttachment(s);
    this.line(ws, `You lunge at ${t.name}!`);
    this.broadcast(s.room, `${s.name} attacks ${t.name}!`, ws);
    this.prompt(ws);
    await this.scheduleNextTick();
  }

  private flee(ws: WebSocket, s: Session): void {
    if (!s.target) {
      this.line(ws, "You're not fighting anything.");
    } else {
      s.target = null;
      ws.serializeAttachment(s);
      this.line(ws, "You break off and catch your breath.");
      this.broadcast(s.room, `${s.name} flees the fight.`, ws);
    }
    this.prompt(ws);
  }

  // ---- items ---------------------------------------------------------------

  private get(ws: WebSocket, s: Session, arg: string): void {
    if (!arg) {
      this.line(ws, "Get what?");
      this.prompt(ws);
      return;
    }
    const item = this.groundItems(s.room).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `There's no "${arg}" here to take.`);
      this.prompt(ws);
      return;
    }
    this.groundRemove(s.room, item, 1);
    this.invAdd(s.name, item, 1);
    const name = ITEM_TEMPLATES[item].name;
    this.line(ws, `You pick up ${name}.`);
    this.broadcast(s.room, `${s.name} picks up ${name}.`, ws);
    this.prompt(ws);
  }

  private drop(ws: WebSocket, s: Session, arg: string): void {
    if (!arg) {
      this.line(ws, "Drop what?");
      this.prompt(ws);
      return;
    }
    const item = this.invItems(s.name).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You aren't carrying "${arg}".`);
      this.prompt(ws);
      return;
    }
    this.invRemove(s.name, item, 1);
    this.groundAdd(s.room, item, 1);
    const name = ITEM_TEMPLATES[item].name;
    this.line(ws, `You drop ${name}.`);
    this.broadcast(s.room, `${s.name} drops ${name}.`, ws);
    this.prompt(ws);
  }

  private async use(ws: WebSocket, s: Session, arg: string): Promise<void> {
    if (!arg) {
      this.line(ws, "Use what?");
      this.prompt(ws);
      return;
    }
    const item = this.invItems(s.name).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You aren't carrying "${arg}".`);
      this.prompt(ws);
      return;
    }
    const t = ITEM_TEMPLATES[item];
    if (!t.use) {
      this.line(ws, `You can't figure out how to use ${t.name}.`);
      this.prompt(ws);
      return;
    }

    if (t.use.effect === "cure_poison") {
      if (!s.poisoned) {
        this.line(ws, "You aren't poisoned. Best to save it.");
        this.prompt(ws);
        return;
      }
      s.poisoned = false;
      this.invRemove(s.name, item, 1);
      this.line(ws, "The antivenom burns cold down your throat; the venom recedes. You are cured.");
    } else if (t.use.effect === "heal") {
      if (s.hp >= s.maxHp) {
        this.line(ws, "You're already at full health.");
        this.prompt(ws);
        return;
      }
      s.hp = Math.min(s.maxHp, s.hp + t.use.amount);
      this.invRemove(s.name, item, 1);
      this.line(ws, `You jolt yourself with ${t.name}. (HP ${s.hp}/${s.maxHp})`);
    } else if (t.use.effect === "drug") {
      // A genuine temptation: a free full heal, at a moral and physical price.
      this.invRemove(s.name, item, 1);
      s.hp = s.maxHp;
      s.morality -= 10;
      s.addiction += 1;
      this.line(
        ws,
        "The dust hits like a sunrise behind your eyes. Pain forgotten, body humming, " +
          `you feel whole again. (HP ${s.hp}/${s.maxHp})`,
      );
      if (s.addiction >= 3) {
        this.line(ws, "But the wanting is louder now. Your hands won't stop shaking when it fades.");
      }
    }

    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private examine(ws: WebSocket, s: Session, arg: string): void {
    if (!arg) {
      this.line(ws, "Examine what?");
      this.prompt(ws);
      return;
    }
    const item =
      this.invItems(s.name).find((id) => itemMatches(id, arg)) ??
      this.groundItems(s.room).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You don't see any "${arg}" to examine.`);
    } else {
      this.line(ws, ITEM_TEMPLATES[item].desc);
    }
    this.prompt(ws);
  }

  // ---- the maiden / quest --------------------------------------------------

  private freeMaiden(ws: WebSocket, s: Session): void {
    if (s.room !== HOLDING_PIT) {
      this.line(ws, "There's no one here to free.");
      this.prompt(ws);
      return;
    }
    const warden = this.loadMob(WARDEN_ID);
    if (warden && warden.state === "alive") {
      this.line(ws, "The warden bars your way, keys jangling. Defeat it first.");
      this.prompt(ws);
      return;
    }
    if (this.invHas(s.name, "antidote")) {
      this.line(ws, 'The maiden smiles weakly. "You already carry my vial. Use it well."');
      this.prompt(ws);
      return;
    }
    this.invAdd(s.name, "antidote", 1);
    this.line(
      ws,
      'You strike the chains free. The maiden presses a vial into your hands:' +
        NL +
        '  "Antivenom, for the poison that haunts these wastes. You have my thanks."',
    );
    this.broadcast(s.room, `${s.name} frees the captive maiden!`, ws);
    this.prompt(ws);
  }

  private talk(ws: WebSocket, s: Session): void {
    if (s.room === HOLDING_PIT) {
      const warden = this.loadMob(WARDEN_ID);
      if (warden && warden.state === "alive") {
        this.line(
          ws,
          'The chained maiden whispers: "The warden holds the only key. Free me, and I will give' +
            ' you antivenom; the wastes are thick with poison."',
        );
      } else {
        this.line(ws, 'The freed maiden says: "Stay safe out there. The antivenom is yours when the venom bites."');
      }
      this.prompt(ws);
      return;
    }

    if (s.room === TAVERN) {
      this.line(
        ws,
        'The dealer rolls a packet of dust between his fingers: "First taste eases any pain, friend.' +
          ' Just say buy dust."' +
          NL +
          "Across the room the tavern wench catches your eye and tilts her head toward the back rooms." +
          NL +
          "(You could buy/use dust, carouse, or resist.)",
      );
      this.prompt(ws);
      return;
    }

    if (s.room === MARKET) {
      if (s.faction === "none") {
        this.line(
          ws,
          'A Cinder Front recruiter bellows from a crate: "The wastes are OURS! Round up every' +
            ' unregistered elf and drive them out!"' +
            NL +
            'A frightened elf refugee murmurs at your side: "Please, I was born here. Don\'t let them take me."' +
            NL +
            "(You could join the Front, or defend the refugees.)",
        );
      } else if (s.faction === "front") {
        this.line(ws, "The recruiter nods at you, one of his own now. The square has gone quiet and afraid.");
      } else {
        this.line(ws, "An elf refugee presses your hand in silent thanks. The recruiter is nowhere in sight.");
      }
      this.prompt(ws);
      return;
    }

    this.line(ws, "There's no one here to talk to.");
    this.prompt(ws);
  }

  // ---- morality: theft, vice, and the Cinder Front -------------------------

  private statusView(ws: WebSocket, s: Session): void {
    const flags = [];
    if (s.poisoned) flags.push("AFFLICTED");
    if (s.addiction >= 3) flags.push("ADDICTED");
    if (s.faction === "front") flags.push("CINDER FRONT");
    if (s.faction === "ally") flags.push("FRIEND OF THE ELVES");
    this.line(ws, `HP ${s.hp}/${s.maxHp}   Level ${s.level}   XP ${s.xp}/${s.level * 100}`);
    this.line(
      ws,
      `Gold ${s.gold}   Standing: ${this.standing(s.morality)} (${s.morality >= 0 ? "+" : ""}${s.morality})` +
        (flags.length ? `   [${flags.join(", ")}]` : ""),
    );
  }

  private standing(m: number): string {
    if (m >= 50) return "a beacon of the wastes";
    if (m >= 20) return "well-regarded";
    if (m > -20) return "unproven";
    if (m > -50) return "shady";
    return "reviled";
  }

  private sell(ws: WebSocket, s: Session, arg: string): void {
    if (s.room !== MARKET) {
      this.line(ws, "There's no one here buying.");
      this.prompt(ws);
      return;
    }
    if (!arg) {
      this.line(ws, "Sell what?");
      this.prompt(ws);
      return;
    }
    const item = this.invItems(s.name).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You aren't carrying "${arg}".`);
      this.prompt(ws);
      return;
    }
    const value = ITEM_TEMPLATES[item].value ?? 0;
    if (value <= 0) {
      this.line(ws, `The vendor drone won't touch ${ITEM_TEMPLATES[item].name}.`);
      this.prompt(ws);
      return;
    }
    this.invRemove(s.name, item, 1);
    s.gold += value;
    this.line(ws, `You sell ${ITEM_TEMPLATES[item].name} for ${value} gold. (gold: ${s.gold})`);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private async steal(ws: WebSocket, s: Session): Promise<void> {
    if (s.room !== MARKET) {
      this.line(ws, "There's nothing here worth lifting.");
      this.prompt(ws);
      return;
    }
    // Theft always costs you morally; getting caught costs you the take too.
    if (Math.random() < 0.4) {
      s.morality -= 5;
      this.line(
        ws,
        "The vendor drone shrieks an alarm and snaps at your hand; you come away with nothing but shame.",
      );
      this.broadcast(s.room, `${s.name} is caught with a hand in the till!`, ws);
    } else {
      const take = rand(8, 20);
      s.gold += take;
      s.morality -= 10;
      this.line(ws, `You palm a pouch from the stall: ${take} gold, and no one the wiser. (gold: ${s.gold})`);
    }
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private buy(ws: WebSocket, s: Session, arg: string): void {
    if (s.room !== TAVERN) {
      this.line(ws, "There's nothing for sale here.");
      this.prompt(ws);
      return;
    }
    if (!itemMatches("dust", arg)) {
      this.line(ws, 'The dealer only deals one thing: dust. ("buy dust")');
      this.prompt(ws);
      return;
    }
    const COST = 10;
    if (s.gold < COST) {
      this.line(ws, `The dealer sneers. "${COST} gold, no credit." You're short.`);
      this.prompt(ws);
      return;
    }
    s.gold -= COST;
    this.invAdd(s.name, "dust", 1);
    this.line(ws, `The dealer slips you a packet of dust. (−${COST} gold, gold: ${s.gold})`);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private async carouse(ws: WebSocket, s: Session): Promise<void> {
    if (s.room !== TAVERN) {
      this.line(ws, "There's no one here to keep you company.");
      this.prompt(ws);
      return;
    }
    const COST = 10;
    if (s.gold < COST) {
      this.line(ws, "The wench looks you over, sees empty pockets, and moves on.");
      this.prompt(ws);
      return;
    }
    s.gold -= COST;
    s.morality -= 8;
    this.line(
      ws,
      "You spend coin and an hour in the back; the details stay between you and the rafters." +
        (s.poisoned
          ? ""
          : NL + "By morning, though, something burns that shouldn't. You've caught the pox. (afflicted)"),
    );
    s.poisoned = true; // "that nonsense": an affliction you'll need to cure
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
    await this.scheduleNextTick(); // the affliction ticks like venom
  }

  private resist(ws: WebSocket, s: Session): void {
    if (s.room !== TAVERN) {
      this.line(ws, "There's no temptation here to resist.");
      this.prompt(ws);
      return;
    }
    if (s.resisted) {
      this.line(ws, "You've already made your peace with this place. You keep your coin and your wits.");
      this.prompt(ws);
      return;
    }
    s.resisted = true;
    s.morality += 5;
    this.line(ws, "You wave off the dust and the wench both, jaw set. Your head stays clear. There's pride in that.");
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private factionChoice(ws: WebSocket, s: Session, side: "front" | "ally"): void {
    if (s.room !== MARKET) {
      this.line(ws, "There's no rally here to weigh in on.");
      this.prompt(ws);
      return;
    }
    if (s.faction !== "none") {
      this.line(ws, "You've already chosen your side. The square remembers.");
      this.prompt(ws);
      return;
    }

    if (side === "front") {
      s.faction = "front";
      s.morality -= 25;
      s.gold += 30;
      this.line(
        ws,
        'You take the recruiter\'s hand. "Good. The wastes need hard men." He presses 30 gold of blood' +
          " money on you as the elf refugee bolts in terror.",
      );
      this.broadcast(s.room, `${s.name} has joined the Cinder Front.`, ws);
    } else {
      s.faction = "ally";
      s.morality += 25;
      this.invAdd(s.name, "charm", 1);
      this.line(
        ws,
        'You step between the recruiter and the refugees: "They stay. They belong here as much as you do."' +
          " The recruiter spits and storms off. The elves press an elven charm into your hands, eyes bright" +
          " with thanks.",
      );
      this.broadcast(s.room, `${s.name} stands with the elves against the Cinder Front.`, ws);
    }
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  // ---- views ---------------------------------------------------------------

  private describeRoom(s: Session): string {
    const room = ROOMS[s.room];
    const lines = [room.name, room.desc];

    const exits = Object.keys(room.exits);
    lines.push(exits.length ? `Exits: ${exits.join(", ")}.` : "There are no obvious exits.");

    if (s.room === HOLDING_PIT) {
      const warden = this.loadMob(WARDEN_ID);
      lines.push(
        warden && warden.state === "alive"
          ? "A captive maiden is chained to the far wall, watching you with desperate hope."
          : "The maiden you freed tends a small fire here, murmuring her thanks.",
      );
    }

    if (s.room === TAVERN) {
      lines.push("A dust-dealer works the shadows, and a tavern wench drifts among the tables. (try 'talk')");
    }

    if (s.room === MARKET) {
      if (s.faction === "none") {
        lines.push(
          "A Cinder Front recruiter rallies a crowd against the 'unregistered elves,' while a frightened" +
            " elf refugee shrinks against the wall. (try 'talk')",
        );
      } else if (s.faction === "front") {
        lines.push("The square is hushed; the recruiter counts you among his own.");
      } else {
        lines.push("Elf refugees move freely here, nodding to you as you pass.");
      }
    }

    const mobs = this.livingMobsInRoom(s.room).map((m) => MOB_BY_ID[m.id].name);
    if (mobs.length) lines.push(`You see: ${mobs.join(", ")}.`);

    const ground = this.groundItems(s.room).map((id) => ITEM_TEMPLATES[id].name);
    if (ground.length) lines.push(`On the ground: ${ground.join(", ")}.`);

    const others = this.playersInRoom(s.room).filter((n) => n !== s.name);
    if (others.length) lines.push(`Also here: ${others.join(", ")}.`);

    return NL + lines.join(NL) + NL;
  }

  private inventoryView(s: Session): string {
    const rows = this.ctx.storage.sql
      .exec<{ item: string; qty: number }>("SELECT item, qty FROM inventory WHERE player = ?", s.name)
      .toArray();
    if (!rows.length) return NL + "You are carrying nothing." + NL;
    const list = rows.map((r) => `  ${ITEM_TEMPLATES[r.item].name}${r.qty > 1 ? ` (x${r.qty})` : ""}`);
    return NL + "You are carrying:" + NL + list.join(NL) + NL;
  }

  private who(): string {
    const names = this.onlineNames();
    return (
      NL +
      `Survivors online (${names.length}):` +
      NL +
      (names.length ? names.map((n) => `  - ${n}`).join(NL) : "  (nobody but you)") +
      NL
    );
  }

  private help(): string {
    return (
      [
        "",
        "Commands:",
        "  look (l)              describe your surroundings",
        "  north/south/...       move (n s e w ne nw se sw u d, or 'go <dir>')",
        "  attack <mob> (k)      start a fight (resolves every few seconds)",
        "  flee (f)              break off combat",
        "  get/take <item>       pick something up off the ground",
        "  drop <item>           drop an item",
        "  inventory (inv, i)    list what you're carrying",
        "  use/drink <item>      use an item (antidote, rad-cell, ...)",
        "  examine <item>        look closely at an item",
        "  free/rescue           free the captive (in the Holding Pit)",
        "  sell <item>           sell salvage to the market vendor (honest coin)",
        "  steal                 lift gold from the market stall (risky, corrupting)",
        "  buy <item>            buy from a vendor (dust, at the Tankard)",
        "  carouse / resist      indulge or refuse the Tankard's vices",
        "  join / defend         side with the Cinder Front, or the elves (Scrap Market)",
        "  talk                  speak to whoever shares your room",
        "  hp / status           show health, level, xp, gold, and standing",
        "  say <message> (')     speak to everyone in the room",
        "  who                   list survivors online",
        "  help (?)              this message",
        "  quit                  disconnect",
      ].join(NL) + NL
    );
  }

  // ---- helpers -------------------------------------------------------------

  private line(ws: WebSocket, text: string): void {
    ws.send(NL + text + NL);
  }

  private prompt(ws: WebSocket): void {
    ws.send("> ");
  }

  private say(ws: WebSocket, s: Session, message: string): void {
    if (!message) {
      this.line(ws, "Say what?");
      return;
    }
    this.line(ws, `You say, "${message}"`);
    this.broadcast(s.room, `${s.name} says, "${message}"`, ws);
  }

  private broadcast(roomId: string, text: string, exclude?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.room === roomId) {
        ws.send(NL + text + NL + "> ");
      }
    }
  }

  private sessions(): Session[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment() as Session | null)
      .filter((s): s is Session => !!s && s.name.length > 0);
  }

  private onlineNames(): string[] {
    return this.sessions().map((s) => s.name);
  }

  private playersInRoom(roomId: string): string[] {
    return this.sessions()
      .filter((s) => s.room === roomId)
      .map((s) => s.name);
  }

  private isNameOnline(name: string): boolean {
    const lower = name.toLowerCase();
    return this.onlineNames().some((n) => n.toLowerCase() === lower);
  }

  private loadMob(id: string): MobRow | null {
    return this.ctx.storage.sql.exec<MobRow>("SELECT * FROM mobs WHERE id = ?", id).toArray()[0] ?? null;
  }

  private livingMobsInRoom(roomId: string): MobRow[] {
    return this.ctx.storage.sql
      .exec<MobRow>("SELECT * FROM mobs WHERE room = ? AND state = 'alive'", roomId)
      .toArray();
  }

  private mobMatches(id: string, arg: string): boolean {
    const a = arg.toLowerCase();
    return id === a || MOB_BY_ID[id].name.toLowerCase().includes(a);
  }

  // inventory + ground helpers (qty-based rows)

  private invItems(player: string): string[] {
    return this.ctx.storage.sql
      .exec<{ item: string }>("SELECT item FROM inventory WHERE player = ? AND qty > 0", player)
      .toArray()
      .map((r) => r.item);
  }

  private invHas(player: string, item: string): boolean {
    const r = this.ctx.storage.sql
      .exec<{ qty: number }>("SELECT qty FROM inventory WHERE player = ? AND item = ?", player, item)
      .toArray()[0];
    return !!r && r.qty > 0;
  }

  private invAdd(player: string, item: string, n: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO inventory (player, item, qty) VALUES (?, ?, ?) ON CONFLICT(player, item) DO UPDATE SET qty = qty + excluded.qty",
      player,
      item,
      n,
    );
  }

  private invRemove(player: string, item: string, n: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE inventory SET qty = qty - ? WHERE player = ? AND item = ?",
      n,
      player,
      item,
    );
    this.ctx.storage.sql.exec("DELETE FROM inventory WHERE player = ? AND item = ? AND qty <= 0", player, item);
  }

  private groundItems(room: string): string[] {
    return this.ctx.storage.sql
      .exec<{ item: string }>("SELECT item FROM ground WHERE room = ? AND qty > 0", room)
      .toArray()
      .map((r) => r.item);
  }

  private groundAdd(room: string, item: string, n: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO ground (room, item, qty) VALUES (?, ?, ?) ON CONFLICT(room, item) DO UPDATE SET qty = qty + excluded.qty",
      room,
      item,
      n,
    );
  }

  private groundRemove(room: string, item: string, n: number): void {
    this.ctx.storage.sql.exec("UPDATE ground SET qty = qty - ? WHERE room = ? AND item = ?", n, room, item);
    this.ctx.storage.sql.exec("DELETE FROM ground WHERE room = ? AND item = ? AND qty <= 0", room, item);
  }

  private persistPlayer(s: Session): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO players (name, room, hp, max_hp, xp, level, poisoned, gold, morality, addiction, faction, resisted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         room = excluded.room, hp = excluded.hp, max_hp = excluded.max_hp,
         xp = excluded.xp, level = excluded.level, poisoned = excluded.poisoned,
         gold = excluded.gold, morality = excluded.morality, addiction = excluded.addiction,
         faction = excluded.faction, resisted = excluded.resisted`,
      s.name,
      s.room,
      s.hp,
      s.maxHp,
      s.xp,
      s.level,
      s.poisoned ? 1 : 0,
      s.gold,
      s.morality,
      s.addiction,
      s.faction,
      s.resisted ? 1 : 0,
    );
  }
}
