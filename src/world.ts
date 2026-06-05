import { DurableObject } from "cloudflare:workers";
import type { Env, Session } from "./types";
import { ROOMS, START_ROOM, HOLDING_PIT, WARDEN_ID, TAVERN, MARKET, normalizeDir } from "./rooms";
import { MOB_TEMPLATES, MOB_BY_ID } from "./mobs";
import { ITEM_TEMPLATES, itemMatches, EQUIP_SLOTS } from "./items";
import type { GridTrace, GridCast, CharSheet, WorldInfo } from "../shared/grid";
import { BANNER_LINES } from "./banner";

const NL = "\r\n"; // wscat / telnet-style clients render CRLF cleanly

// This world's name on the federation defaults here but is overridable per
// deployment via the WORLD_NAME var (see this.worldName). That is what lets the
// same code run as two distinct worlds on one Grid: each registers under its own
// name and url, so neither clobbers the other's registry entry.
const DEFAULT_WORLD_NAME = "The Hollow Grid";

const ROUND_MS = 3_000; // combat + poison resolve one tick every 3 seconds
const BASE_HP = 30;
const POISON_DMG = 1; // hp lost per tick while poisoned

// The living world advances on the same ~3s alarm tick. These are how many
// ticks pass between each kind of change (kept slow enough to feel like weather,
// not a strobe light): a full day is ~PHASE_TICKS*4 ticks.
const PHASE_TICKS = 20; // day -> dusk -> night -> dawn, each ~1 minute
const WEATHER_TICKS = 9; // roll for a weather change ~every 27s
const GHOST_TICKS = 4; // the Grid-ghost drifts a room ~every 12s

const PHASES = ["dawn", "day", "dusk", "night"] as const;
const PHASE_LINE: Record<string, string> = {
  dawn: "A bruised light bleeds over the ridge. Dawn, such as it is.",
  day: "The sun clears the wreckage. Day settles, white and pitiless.",
  dusk: "The light goes long and red. Dusk creeps in from the east.",
  night: "The sun dies behind the ridge and the wastes go cold and blue. Night.",
};
const WEATHERS = ["clear", "a haze of grid-static", "acid drizzle", "a dust storm", "an unnatural stillness"];
const WEATHER_LINE: Record<string, string> = {
  clear: "The air clears. For once you can see to the horizon.",
  "a haze of grid-static": "A haze of grid-static rolls in, prickling your skin and your HUD alike.",
  "acid drizzle": "Acid drizzle begins to fall, hissing where it lands.",
  "a dust storm": "A dust storm boils up out of the flats; the world narrows to arm's length.",
  "an unnatural stillness": "The wind dies completely. An unnatural stillness settles, and the Grid seems to hold its breath.",
};

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

// Body positions. Resting/sleeping regen HP on the alarm tick; you can't do
// either mid-fight, and attacking from one snaps you to your feet.
const POS_REGEN: Record<string, number> = { sleeping: 4, resting: 2, sitting: 0, standing: 0 };
const POS_SELF: Record<string, string> = {
  resting: "You sink down and rest, letting your wounds knit.",
  sleeping: "You close your eyes and sleep. The wastes fade away.",
  sitting: "You sit down on the cracked ground.",
  standing: "You get to your feet.",
};
const POS_OTHERS: Record<string, string> = {
  resting: "sits down to rest",
  sleeping: "lies down and falls asleep",
  sitting: "sits down",
  standing: "gets to their feet",
};
const POS_ALREADY: Record<string, string> = {
  resting: "already resting",
  sleeping: "already asleep",
  sitting: "already sitting",
  standing: "already on your feet",
};
const condition = (o: { hp: number; maxHp: number }): string => {
  const r = o.maxHp > 0 ? o.hp / o.maxHp : 0;
  return r >= 0.95 ? "in good shape" : r >= 0.6 ? "scuffed up" : r >= 0.3 ? "bloodied" : "barely standing";
};

// The Tinker's Workshop gear shop: item id -> price in gold. `list` shows it,
// `buy <item>` purchases it (the tavern still sells only dust).
const WORKSHOP_WARES: { item: string; price: number }[] = [
  { item: "shiv", price: 12 },
  { item: "helm", price: 14 },
  { item: "antidote", price: 14 },
  { item: "radcell", price: 16 },
  { item: "plating", price: 18 },
  { item: "rebar", price: 45 },
];

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
  // This deployment's federation identity. Set once from the env so two Workers
  // running this same code register as distinct worlds on the shared Grid.
  private readonly worldName: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.worldName = env.WORLD_NAME?.trim() || DEFAULT_WORLD_NAME;
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
          resisted INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL DEFAULT ''
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
        "title TEXT NOT NULL DEFAULT ''",
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

      // Worn/wielded gear: one item per slot per player.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS equipment (
          player TEXT NOT NULL,
          slot TEXT NOT NULL,
          item TEXT NOT NULL,
          PRIMARY KEY (player, slot)
        )
      `);

      // The Grid: the dead network's persistent memory of what happened where.
      // Passings, deaths, oaths, and kills leave an echo tied to a node and
      // outlive the people who made them -- query a node with `ping`.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS grid_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node TEXT NOT NULL,
          at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL
        )
      `);

      // The living world: a single-row clock the alarm advances while anyone is
      // online -- time of day, weather, the faction tide, and a wandering ghost.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS world (
          id INTEGER PRIMARY KEY,
          tick INTEGER NOT NULL DEFAULT 0,
          phase TEXT NOT NULL DEFAULT 'day',
          weather TEXT NOT NULL DEFAULT 'clear',
          tide INTEGER NOT NULL DEFAULT 0,
          ghost_room TEXT NOT NULL DEFAULT '${START_ROOM}',
          last_cast INTEGER NOT NULL DEFAULT 0
        )
      `);
      try {
        sql.exec("ALTER TABLE world ADD COLUMN last_cast INTEGER NOT NULL DEFAULT 0");
      } catch {
        // column already exists
      }
      sql.exec("INSERT OR IGNORE INTO world (id) VALUES (0)");
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
      [...BANNER_LINES, "", "By what name are you known, wanderer?"].join(NL) + NL,
    );

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const line = (typeof message === "string" ? message : new TextDecoder().decode(message)).trim();
    const session = ws.deserializeAttachment() as Session | null;

    if (!session || !session.name) {
      await this.handleLogin(ws, line);
      return;
    }
    await this.handleCommand(ws, session, line);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const session = ws.deserializeAttachment() as Session | null;
    if (session?.name) {
      this.broadcast(session.room, `${session.name} flickers out of existence.`, ws);
      this.commitIdentity(session); // checkpoint the canonical character to the hub
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
      this.emitVitals(ws, s);
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.prompt(ws);
    }

    // 2.5) Passive HP regen for resting/sleeping players (not fighting/poisoned).
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (!s?.name || s.target || s.poisoned || s.hp >= s.maxHp) continue;
      const regen = POS_REGEN[s.position ?? "standing"] ?? 0;
      if (regen <= 0) continue;
      s.hp = Math.min(s.maxHp, s.hp + regen);
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.emitVitals(ws, s);
      if (s.hp >= s.maxHp) {
        this.line(ws, "Your wounds have closed. You feel whole again.");
        this.prompt(ws);
      }
    }

    // 3) Combat rounds. Deserialize per ws so kills/deaths this tick are seen.
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.target) this.resolveRound(ws, s);
    }

    // 4) Advance the living world (time of day, weather, the ghost).
    this.worldTick();

    // 5) Federation: relay any new cross-world gridcasts to our players.
    await this.pollGridcasts();

    await this.scheduleNextTick();
  }

  /** Schedule the next alarm only if there's combat, a respawn, or poison. */
  private async scheduleNextTick(): Promise<void> {
    const now = Date.now();
    let next = Infinity;

    // Beat every tick while ANYONE is online, so the living world keeps turning
    // for them (combat/poison alone aren't required); the alarm stops and the DO
    // hibernates once the last player disconnects.
    const anyoneOnline = this.ctx.getWebSockets().some((ws) => {
      const s = ws.deserializeAttachment() as Session | null;
      return !!s && s.name.length > 0;
    });
    if (anyoneOnline) next = Math.min(next, now + ROUND_MS);

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
      this.event(ws, "combat.end", { result: "gone" });
      this.emitVitals(ws, s);
      this.line(ws, "Your quarry is gone. You stand down.");
      this.prompt(ws);
      return;
    }

    // Player strikes first (wielded gear adds to the swing).
    const bonus = this.equipBonuses(s.name);
    const pdmg = rand(3, 7) + (s.level - 1) * 2 + bonus.damage;
    const mobHp = Math.max(0, mob.hp - pdmg);
    this.ctx.storage.sql.exec("UPDATE mobs SET hp = ? WHERE id = ?", mobHp, mob.id);
    this.line(ws, `You hit ${t.name} for ${pdmg}. (${mobHp}/${mob.max_hp})`);

    if (mobHp <= 0) {
      this.killMob(ws, s, mob, t);
      return;
    }

    // Mob hits back (worn armor soaks some), possibly envenomating.
    const mdmg = Math.max(1, rand(t.minDmg, t.maxDmg) - bonus.armor);
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

    this.event(ws, "combat.round", {
      mob: mob.id,
      mobHp,
      mobMaxHp: mob.max_hp,
      playerDmg: pdmg,
      mobDmg: mdmg,
      hp: s.hp,
    });
    this.emitVitals(ws, s);
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
    this.recordTrace(mob.room, "slain", `${s.name} slew ${t.name} here.`);
    if (mob.id === "ashmonger") {
      s.morality += 20;
      this.worldBroadcast("Word races across the wastes: the Ashmonger is dead. The Cinder Front's heart is broken.");
    }

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
    this.event(ws, "combat.end", { mob: mob.id, result: "killed", xp: t.xp });
    this.emitVitals(ws, s);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private killPlayer(ws: WebSocket, s: Session): void {
    this.line(ws, "Your vision whites out and you crumple into the dust...");
    this.broadcast(s.room, `${s.name} collapses, lifeless.`, ws);

    // Death has a FLOOR. The player respawns at the start, fully healed, with
    // NO lost levels/xp/gold and NO reduction to max HP. Deaths must never
    // compound into an unrecoverable spiral (the lesson from watching a bot rot
    // from 30 max HP to 14 and die faster each time). If you ever add a death
    // penalty, make it temporary and bounded -- never a permanent stat loss.
    this.recordTrace(s.room, "death", `${this.tagged(s)} fell here, and did not get up.`);
    s.target = null;
    s.poisoned = false; // death burns the venom out
    s.room = START_ROOM;
    s.hp = s.maxHp;
    ws.serializeAttachment(s);
    this.persistPlayer(s);

    this.line(ws, "...and wake, gasping, back at The Cracked Nexus.");
    this.broadcast(START_ROOM, `${s.name} staggers in, pale and shaking.`, ws);
    // Death is observable on the structured channel; the room.info + char.vitals
    // from sendRoom below confirm the full-HP respawn at the start room.
    this.event(ws, "char.died", { respawnRoom: START_ROOM, hp: s.hp, maxHp: s.maxHp });
    this.sendRoom(ws, s);
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
    this.commitIdentity(s); // checkpoint xp/level to the federated identity
  }

  // ---- login ---------------------------------------------------------------

  private async handleLogin(ws: WebSocket, raw: string): Promise<void> {
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
        title: string;
      }>(
        "SELECT room, hp, max_hp, xp, level, poisoned, gold, morality, addiction, faction, resisted, title FROM players WHERE name = ?",
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
      gold: row?.gold ?? 20, // new characters wake with a few coins
      morality: row?.morality ?? 0,
      addiction: row?.addiction ?? 0,
      faction: (row?.faction as Session["faction"]) ?? "none",
      resisted: !!row?.resisted,
      title: row?.title ?? "",
    };

    // Federation phase 3: the canonical identity (progression + standing) lives
    // in the Grid Hub, so a character is the same person in every world. Load it
    // over the local shared fields; keep local-only state (room, hp, inventory).
    // If the hub is down, the local sheet stands -- federation is never required.
    try {
      const canon = await this.env.GRID.loadCharacter(name);
      session.level = canon.level;
      session.xp = canon.xp;
      session.gold = canon.gold;
      session.faction = canon.faction as Session["faction"];
      session.morality = canon.morality;
      session.title = canon.title;
      session.maxHp = BASE_HP + (canon.level - 1) * 10; // max HP follows your level
      // Advertise this world to the federation registry (keeps its entry live).
      // waitUntil so the RPC survives this handler returning -- across the service
      // binding a bare fire-and-forget can be cancelled before it lands.
      this.ctx.waitUntil(
        this.env.GRID.register(this.worldName, this.env.WORLD_URL ?? "ws://localhost:8787/ws").catch(() => {}),
      );
    } catch {
      /* hub unreachable; the local character stands on its own */
    }

    if (session.hp <= 0 || session.hp > session.maxHp) session.hp = session.maxHp;
    ws.serializeAttachment(session);
    this.persistPlayer(session);

    // Self-documenting onboarding: never make a new player guess. State the
    // goal and how to learn every command, and promise that nothing is gated
    // behind secret words (the anti-"hidden search gate" lesson, in-voice).
    if (!row) {
      this.invAdd(name, "shiv", 1); // a starter weapon: you wake clutching it
      ws.send(
        [
          `Welcome to the wastes, ${name}. You wake in the ruins of the Grid with a rusted shiv in your fist and little else.`,
          "Survive, explore, and decide what the wastes make of you. Nothing here is hidden",
          "behind secret commands: type 'help' (or '?') for everything you can do, and 'look'",
          "to take in your surroundings. The exits of each room are always listed.",
        ].join(NL) + NL,
      );
    } else {
      ws.send(`Welcome back to the wastes, ${name}. (Type 'help' if you need a refresher.)` + NL);
    }
    this.broadcast(room, `${name} steps out of the haze.`, ws);
    this.sendRoom(ws, session);
    this.emitWorldState(ws);
    if (session.poisoned) this.line(ws, "The old venom still burns in you. (poisoned)");
    this.prompt(ws);
    // Start the world heartbeat for this session (it keeps the alarm beating
    // so the living world turns; it stops when the last player leaves).
    void this.scheduleNextTick();
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
        this.lookAt(ws, s, arg);
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
      case "list":
        this.listWares(ws, s);
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
      case "tell":
        this.tell(ws, s, arg);
        break;
      case "reply":
        this.reply(ws, s, arg);
        break;
      case "emote":
      case "em":
      case "pose":
        this.emote(ws, s, arg);
        break;
      case "yell":
      case "shout":
        this.yell(ws, s, arg);
        break;
      case "give":
        this.give(ws, s, arg);
        break;
      case "exits":
      case "exit":
        this.exitsView(ws, s);
        break;
      case "consider":
      case "con":
        this.consider(ws, s, arg);
        break;
      case "recall":
      case "home":
        this.recall(ws, s);
        break;
      case "affects":
      case "affs":
        this.affects(ws, s);
        break;
      case "rest":
        this.setPosition(ws, s, "resting");
        break;
      case "sleep":
        this.setPosition(ws, s, "sleeping");
        break;
      case "sit":
        this.setPosition(ws, s, "sitting");
        break;
      case "stand":
      case "wake":
        this.setPosition(ws, s, "standing");
        break;
      case "wear":
      case "wield":
      case "equip":
        this.equip(ws, s, arg);
        break;
      case "remove":
      case "unwield":
        this.unequip(ws, s, arg);
        break;
      case "equipment":
      case "eq":
        this.equipmentView(ws, s);
        break;
      case "title":
        this.setTitle(ws, s, arg);
        break;
      case "ping":
        await this.gridPing(ws, s, arg);
        break;
      case "gridcast":
      case "gc":
        await this.gridcast(ws, s, arg);
        break;
      case "war":
      case "tide":
        await this.warReport(ws);
        break;
      case "whoami":
      case "identity":
        await this.whoami(ws, s);
        break;
      case "worlds":
        await this.worldsList(ws, s);
        break;
      case "travel":
        await this.travel(ws, s, arg);
        break;
      case "wall":
      case "announce":
        this.wall(ws, s, arg);
        break;
      case "world":
      case "weather":
      case "time": {
        const w = this.world();
        this.line(ws, `The sky: ${w.phase}, ${w.weather}.`);
        this.emitWorldState(ws);
        this.prompt(ws);
        break;
      }
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
    const mark = this.brand(s);
    this.broadcast(destId, mark ? `${s.name}, ${mark}, arrives.` : `${s.name} arrives.`, ws);
    this.recordTrace(destId, "passage", `${this.tagged(s)} passed through.`);
    this.sendRoom(ws, s);
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
    if ((s.position ?? "standing") !== "standing") {
      s.position = "standing";
      this.line(ws, "You scramble to your feet.");
    }
    s.target = mob.id;
    ws.serializeAttachment(s);
    this.event(ws, "combat.start", { mob: mob.id, name: t.name });
    this.emitVitals(ws, s);
    this.line(ws, `You lunge at ${t.name}!`);
    this.broadcast(s.room, `${s.name} attacks ${t.name}!`, ws);
    this.prompt(ws);
    await this.scheduleNextTick();
  }

  private flee(ws: WebSocket, s: Session): void {
    if (!s.target) {
      this.line(ws, "You're not fighting anything.");
    } else {
      const fled = s.target;
      s.target = null;
      ws.serializeAttachment(s);
      this.event(ws, "combat.end", { mob: fled, result: "fled" });
      this.emitVitals(ws, s);
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

    this.emitAffects(ws, s);
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
    if (s.room === "cells") {
      s.morality += 15;
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.emitAffects(ws, s);
      this.line(
        ws,
        "You wrench the cages open. The refugees pour out and scatter into the dark, some pausing only to " +
          "grip your hand on the way past. Whatever else you are, whatever else you've done -- you did this.",
      );
      this.broadcast(s.room, `${s.name} throws open the Front's cages!`, ws);
      this.recordTrace(s.room, "quest", `${this.tagged(s)} freed the caged refugees here.`);
      this.prompt(ws);
      return;
    }

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

    if (s.room === "workshop") {
      this.line(
        ws,
        'The tinker doesn\'t look up from their soldering. "Salvage\'s on the racks, prices on the list. ' +
          "Say 'list', say 'buy'. I don't haggle and I don't chat.\"",
      );
      this.prompt(ws);
      return;
    }

    if (s.room === "floodgate") {
      if (this.invItems(s.name).includes("shard")) {
        // Quest turn-in: the operator takes the shard and rewards you well.
        this.invRemove(s.name, "shard", 1);
        s.gold += 50;
        this.awardXp(ws, s, 60);
        s.hp = s.maxHp;
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.line(
          ws,
          'The operator\'s face cracks into something like joy. "The core shard -- you actually did it. Here, ' +
            'take my coin, all of it, and let me patch you up. The wastes owe you better than I can pay." ' +
            "(+50 gold, +60 xp, fully healed)",
        );
        this.recordTrace(s.room, "quest", `${this.tagged(s)} restored the node here with the core shard.`);
      } else {
        this.line(
          ws,
          'A stranded operator looks up from a dead console: "I can\'t leave until this node is restored, and ' +
            "the Custodian dragged the core shard down into the Core Lab. Kill it, bring me the shard, and " +
            'I\'ll give you everything I have."',
        );
      }
      this.prompt(ws);
      return;
    }

    if (s.room === "checkpoint") {
      if (s.faction === "front") {
        this.line(ws, 'The enforcer claps your shoulder. "Good to see the cause has hands. The road is yours -- crack a few refugee skulls for me."');
      } else if (s.faction === "ally") {
        this.line(ws, 'The enforcer levels a gun at your chest. "Elf-lover. You do not pass here. Turn around, or draw." (you may have to fight your way through)');
      } else {
        this.line(ws, 'The enforcer blocks the barrier. "Pick a side before you come up this road. The Front is always hiring."');
      }
      this.prompt(ws);
      return;
    }

    if (s.room === "waystation") {
      if (s.faction === "ally") {
        s.hp = s.maxHp;
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.emitVitals(ws, s);
        this.line(ws, 'The medic pulls you onto the cot, cleans your wounds, and presses a hand to your shoulder. "You stood with us when it counted. Rest, friend -- you are whole again." (fully healed)');
      } else if (s.faction === "front") {
        this.line(ws, 'A refugee spits at your feet. "Cinder Front. We know what you are. Get gone, before we make you." There is no help for you here.');
      } else {
        this.line(ws, 'The medic studies you. "We tend friends of the free folk. Pick a side, wanderer, and we will see."');
      }
      this.prompt(ws);
      return;
    }

    if (s.room === "dais") {
      if (s.faction === "ally") {
        this.line(ws, 'The Ashmonger laughs, low and delighted. "The elf-lover walked right into my house. Bold. I am going to wear you as a banner." There is no talking your way out of this -- only steel.');
      } else if (s.faction === "front") {
        this.line(ws, 'The Ashmonger claps a heavy hand on your shoulder. "You came far for the cause. Kneel and take your place at my right hand -- or find your spine and \'defy\' me, here and now. Choose what you are."');
      } else {
        this.line(ws, 'The Ashmonger spits. "Pledge to the Front or get off my dais. I have no patience for fence-sitters."');
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
    if (s.faction === "front") {
      // The market is the free folk's ground; they remember who marched against
      // them. The Cinder Front doesn't get to sell here. Some doors stay shut.
      this.line(
        ws,
        'The vendor drone\'s optic flares red. "Cinder Front. We remember Scrap Market. We don\'t' +
          ' trade with your kind." It turns its back on you, and the stalls nearby go quiet.',
      );
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
    const base = ITEM_TEMPLATES[item].value ?? 0;
    if (base <= 0) {
      this.line(ws, `The vendor drone won't touch ${ITEM_TEMPLATES[item].name}.`);
      this.prompt(ws);
      return;
    }
    // The free folk remember their friends, too: allies get a fair-and-then-some price.
    const value = s.faction === "ally" ? Math.round(base * 1.2) : base;
    this.invRemove(s.name, item, 1);
    s.gold += value;
    const bonus = value > base ? " (the elves see you right)" : "";
    this.line(ws, `You sell ${ITEM_TEMPLATES[item].name} for ${value} gold.${bonus} (gold: ${s.gold})`);
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
    if (s.room === TAVERN) {
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
      return;
    }

    if (s.room === "workshop") {
      if (!arg.trim()) {
        this.line(ws, "Buy what? Say 'list' to see the tinker's wares.");
        this.prompt(ws);
        return;
      }
      const ware = WORKSHOP_WARES.find((w) => itemMatches(w.item, arg));
      if (!ware) {
        this.line(ws, `The tinker doesn't stock any "${arg}". (try 'list')`);
        this.prompt(ws);
        return;
      }
      if (s.gold < ware.price) {
        this.line(ws, `The tinker shakes their head. "${ware.price} gold for that. You've got ${s.gold}."`);
        this.prompt(ws);
        return;
      }
      s.gold -= ware.price;
      this.invAdd(s.name, ware.item, 1);
      this.line(ws, `The tinker hands you ${ITEM_TEMPLATES[ware.item].name}. (−${ware.price} gold, gold: ${s.gold})`);
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.prompt(ws);
      return;
    }

    this.line(ws, "There's nothing for sale here.");
    this.prompt(ws);
  }

  // list: show a shop's wares (only the tinker's workshop, for now).
  private listWares(ws: WebSocket, s: Session): void {
    if (s.room !== "workshop") {
      this.line(ws, "There's no shopkeeper here to list wares.");
      this.prompt(ws);
      return;
    }
    const lines = ["The tinker's wares (buy <item>):"];
    for (const w of WORKSHOP_WARES) {
      lines.push(`  ${String(w.price).padStart(3)}g  ${ITEM_TEMPLATES[w.item].name}`);
    }
    lines.push(`  -- you have ${s.gold} gold.`);
    this.line(ws, lines.join(NL));
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
    this.emitAffects(ws, s);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private factionChoice(ws: WebSocket, s: Session, side: "front" | "ally"): void {
    // The faction arc's climax: at the Ashmonger's dais you can turn on the
    // Front (defect to the free folk) or, if unaligned, pledge yourself to it.
    if (s.room === "dais") {
      if (side === "ally" && s.faction === "front") {
        s.faction = "ally";
        s.morality += 30;
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.emitAffects(ws, s);
        this.recordTrace(s.room, "oath", `${s.name} turned on the Cinder Front at the Ashmonger's own dais.`);
        this.contributeTide(15);
        this.commitIdentity(s);
        this.line(
          ws,
          'You spit at the Ashmonger\'s boots. "I\'m done being your dog." Every soldier in the stronghold turns on you at once' +
            " -- but you stand with the free folk now, and the wastes will remember THIS above all.",
        );
        this.broadcast(s.room, `${s.name} has turned against the Cinder Front!`, ws);
      } else if (side === "front" && s.faction === "none") {
        s.faction = "front";
        s.morality -= 25;
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.emitAffects(ws, s);
        this.recordTrace(s.room, "oath", `${s.name} swore themselves to the Cinder Front at the Ashmonger's dais.`);
        this.contributeTide(-15);
        this.commitIdentity(s);
        this.line(ws, 'You kneel and swear yourself to the Front. The Ashmonger\'s hand closes on your shoulder like a trap. "Good. The wastes will be ours."');
      } else {
        this.line(ws, "The Ashmonger only laughs. There's nothing here to decide that your blood hasn't already settled.");
      }
      this.prompt(ws);
      return;
    }

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
      this.recordTrace(s.room, "oath", `${s.name} swore themselves to the Cinder Front here.`);
      this.contributeTide(-10);
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
      this.recordTrace(s.room, "oath", `${s.name} stood with the free folk here.`);
      this.contributeTide(10);
    }
    this.commitIdentity(s);
    this.emitAffects(ws, s);
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

    const w = this.world();
    lines.push(`The sky: ${w.phase}, ${w.weather}.`);

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

    if (s.room === "workshop") {
      lines.push("A grizzled tinker hunches over the benches, salvaged gear laid out for sale. (try 'list')");
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

    if (s.room === "checkpoint") {
      if (s.faction === "front") {
        lines.push("The enforcer thumps a fist to their chest in salute -- one of theirs. (try 'talk')");
      } else if (s.faction === "ally") {
        lines.push("The enforcer's hand drops to their weapon the moment they place your face. (try 'talk')");
      } else {
        lines.push("The enforcer watches you, weighing which side you're on. (try 'talk')");
      }
    }

    if (s.room === "waystation") {
      if (s.faction === "front") {
        lines.push("The free folk go silent and still. You are not welcome here. (try 'talk')");
      } else if (s.faction === "ally") {
        lines.push("The refugees brighten at a friend's face; the medic waves you over. (try 'talk')");
      } else {
        lines.push("The medic watches you cautiously, one hand near the triage kit. (try 'talk')");
      }
    }

    if (s.room === "gate" || s.room === "muster") {
      if (s.faction === "front") {
        lines.push("Troopers snap to attention as you pass -- one of the cause.");
      } else if (s.faction === "ally") {
        lines.push("Every trooper here would gut you on sight. You are deep in enemy ground.");
      } else {
        lines.push("Troopers track you, hands on their weapons, deciding whether you belong.");
      }
    }

    if (s.room === "dais") {
      if (s.faction === "ally") {
        lines.push("The Ashmonger's eyes find you and narrow -- he knows exactly whose side you're on. (try 'talk', then steel)");
      } else if (s.faction === "front") {
        lines.push("The Ashmonger beckons you up, one of his own. (try 'talk' -- and decide who you really are)");
      } else {
        lines.push("The Ashmonger sizes you up, unimpressed. (try 'talk')");
      }
    }

    const mobs = this.livingMobsInRoom(s.room).map((m) => MOB_BY_ID[m.id].name);
    if (mobs.length) lines.push(`You see: ${mobs.join(", ")}.`);

    const ground = this.groundItems(s.room).map((id) => ITEM_TEMPLATES[id].name);
    if (ground.length) lines.push(`On the ground: ${ground.join(", ")}.`);

    const others = this.sessions().filter((o) => o.room === s.room && o.name !== s.name);
    if (others.length) lines.push(`Also here: ${others.map((o) => this.tagged(o)).join(", ")}.`);

    return NL + lines.join(NL) + NL;
  }

  // --- Structured state channel (GMCP-style) --------------------------------
  // Alongside the human-readable prose, we emit machine-readable events, each on
  // its own line: `@event <name> <json>`. A plain client (wscat) can ignore
  // these lines; a smart client, bot, test harness, or world-mapper parses them
  // for EXACT game state instead of scraping English. This is the single
  // highest-leverage thing a MUD can do for testability and tooling. Anything
  // canonical (the room graph, vitals) is emitted HERE, never split between
  // prose-only and structured -- that inconsistency is what breaks parsers.
  private event(ws: WebSocket, name: string, data: unknown): void {
    ws.send(`@event ${name} ${JSON.stringify(data)}` + NL);
  }

  // Send a room's prose AND its structured room.info + char.vitals together, so
  // the two channels can never drift apart. Use everywhere a room is shown.
  private sendRoom(ws: WebSocket, s: Session): void {
    ws.send(this.describeRoom(s));
    const room = ROOMS[s.room];
    this.event(ws, "room.info", {
      id: room.id,
      name: room.name,
      exits: Object.keys(room.exits),
      mobs: this.livingMobsInRoom(s.room).map((m) => ({ id: m.id, name: MOB_BY_ID[m.id].name })),
      items: this.groundItems(s.room).map((id) => ({ id, name: ITEM_TEMPLATES[id].name })),
      players: this.sessions()
        .filter((o) => o.room === s.room && o.name !== s.name)
        .map((o) => ({ name: o.name, standing: this.brand(o) })),
    });
    this.emitVitals(ws, s);
    this.emitAffects(ws, s);
  }

  // Emit current vitals. Call after anything that changes hp/maxHp/combat state.
  private emitVitals(ws: WebSocket, s: Session): void {
    this.event(ws, "char.vitals", {
      hp: s.hp,
      maxHp: s.maxHp,
      level: s.level,
      xp: s.xp,
      gold: s.gold,
      room: s.room,
      inCombat: s.target !== null,
      poisoned: s.poisoned,
      position: s.position ?? "standing",
    });
  }

  // Emit the player's social/moral state -- the game's signature systems -- so
  // bots, clients, and tests can read addiction/morality/faction directly
  // instead of inferring them from flavor text. Call wherever these change.
  private emitAffects(ws: WebSocket, s: Session): void {
    this.event(ws, "char.affects", {
      morality: s.morality,
      addiction: s.addiction,
      faction: s.faction,
      resisted: s.resisted,
    });
  }

  // The public BRAND the world remembers about a player. Faction is permanent
  // and always shown -- siding with the Cinder Front marks you visibly and does
  // not wash off; standing with the free folk is likewise known. Otherwise only
  // the notable moral extremes earn a public tag (newcomers stay untagged).
  private brand(s: Session): string {
    if (s.faction === "front") return "Cinder Front";
    if (s.faction === "ally") return "Free Folk ally";
    if (s.morality >= 50) return "a beacon of the wastes";
    if (s.morality <= -50) return "reviled";
    return "";
  }

  // A player's name tagged with what the world remembers about them.
  private tagged(s: Session): string {
    const label = this.brand(s);
    const t = s.title ? `, ${s.title}` : "";
    return label ? `${s.name}${t} (${label})` : `${s.name}${t}`;
  }

  // --- The Grid: the dead network's memory ----------------------------------
  // Record a trace at a node. The Grid keeps a long memory, but we cap each node
  // to its most recent entries so it stays bounded without feeling forgetful.
  private recordTrace(node: string, kind: string, text: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO grid_log (node, at, kind, text) VALUES (?, ?, ?, ?)", node, Date.now(), kind, text);
    sql.exec(
      "DELETE FROM grid_log WHERE node = ? AND id NOT IN " +
        "(SELECT id FROM grid_log WHERE node = ? ORDER BY id DESC LIMIT 50)",
      node,
      node,
    );
    // Federation: mirror into the shared Grid ledger, best-effort. If the hub is
    // unreachable, the world runs standalone -- federation is additive, never a
    // dependency (see docs/federation.md).
    try {
      // waitUntil keeps this best-effort mirror alive past the current handler
      // without blocking play; across the service binding an un-tracked promise
      // can be cancelled before the trace reaches the hub.
      this.ctx.waitUntil(this.env.GRID.record(this.worldName, node, kind, text, Date.now()).catch(() => {}));
    } catch {
      /* hub binding unavailable; local play is unaffected */
    }
  }

  // --- Federation phase 2: the global tide + cross-world chat ----------------
  // Move the federation-wide faction needle (best-effort). Negative = the Front
  // gains; positive = the free folk gain.
  private contributeTide(delta: number): void {
    try {
      this.ctx.waitUntil(this.env.GRID.shiftTide(delta).catch(() => {}));
    } catch {
      /* hub unavailable; the choice still stands locally */
    }
  }

  // Commit the player's canonical identity (progression + standing) to the hub,
  // best-effort. The hub validates the proposal; we never block on it.
  private commitIdentity(s: Session): void {
    try {
      this.ctx.waitUntil(
        this.env.GRID
          .commitCharacter(s.name, {
            level: s.level,
            xp: s.xp,
            gold: s.gold,
            faction: s.faction,
            morality: s.morality,
            title: s.title ?? "",
          })
          .catch(() => {}),
      );
    } catch {
      /* hub unavailable */
    }
  }

  // `whoami`: your federation-wide self, read live from the Grid Hub.
  private async whoami(ws: WebSocket, s: Session): Promise<void> {
    let sheet: CharSheet;
    try {
      sheet = await this.env.GRID.loadCharacter(s.name);
    } catch {
      sheet = { level: s.level, xp: s.xp, gold: s.gold, faction: s.faction, morality: s.morality, title: s.title ?? "" };
      this.line(ws, "(the Grid is unreachable; showing your local self)");
    }
    const standing = sheet.faction === "front" ? "Cinder Front" : sheet.faction === "ally" ? "Free Folk ally" : "unaligned";
    this.line(
      ws,
      [
        `You are ${s.name}${sheet.title ? ", " + sheet.title : ""} -- known across the Grid.`,
        `  level ${sheet.level}   xp ${sheet.xp}   gold ${sheet.gold}`,
        `  standing: ${standing}   (morality ${sheet.morality})`,
        "  This identity is canonical on the Grid; it follows you to every world.",
      ].join(NL),
    );
    this.event(ws, "char.identity", sheet);
    this.prompt(ws);
  }

  // `worlds`: the worlds linked on the Grid -- where you can travel.
  private async worldsList(ws: WebSocket, s: Session): Promise<void> {
    let worlds: WorldInfo[] = [];
    try {
      worlds = await this.env.GRID.listWorlds();
    } catch {
      this.line(ws, "The Grid is silent; you can't see the other worlds from here.");
      this.prompt(ws);
      return;
    }
    const now = Date.now();
    const lines = ["Worlds linked on the Grid (say 'travel <world>'):"];
    for (const w of worlds) {
      const live = w.last_seen > now - 60_000 ? "live" : "quiet";
      lines.push(`  ${w.id}  [${live}]${w.id === this.worldName ? "   <- you are here" : ""}`);
    }
    this.line(ws, lines.join(NL));
    this.event(ws, "grid.worlds", {
      worlds: worlds.map((w) => ({ id: w.id, live: w.last_seen > now - 60_000, here: w.id === this.worldName })),
    });
    this.prompt(ws);
  }

  // `travel <world>`: cross the Grid to another world. Your canonical character
  // is checkpointed to the hub, then you're routed onward -- reconnect there and
  // you arrive as yourself (the v1 model: log out here, log in there).
  private async travel(ws: WebSocket, s: Session, arg: string): Promise<void> {
    const target = arg.trim();
    if (!target) {
      this.line(ws, "Travel where? (say 'worlds' to see the Grid)");
      this.prompt(ws);
      return;
    }
    if (s.target) {
      this.line(ws, "You can't key out through the Grid in the middle of a fight.");
      this.prompt(ws);
      return;
    }
    let worlds: WorldInfo[] = [];
    try {
      worlds = await this.env.GRID.listWorlds();
    } catch {
      this.line(ws, "The Grid won't answer; travel is impossible right now.");
      this.prompt(ws);
      return;
    }
    const t = target.toLowerCase();
    const dest = worlds.find((w) => w.id.toLowerCase() === t) ?? worlds.find((w) => w.id.toLowerCase().includes(t));
    if (!dest) {
      this.line(ws, `No world called "${target}" answers on the Grid. (try 'worlds')`);
      this.prompt(ws);
      return;
    }
    if (dest.id === this.worldName) {
      this.line(ws, `You're already in ${this.worldName}.`);
      this.prompt(ws);
      return;
    }
    // Checkpoint the canonical character so it's waiting for you on the far side.
    this.commitIdentity(s);
    this.broadcast(s.room, `${s.name} keys into the Grid and is routed away, off the edge of the world.`, ws);
    this.line(
      ws,
      [
        `The Grid takes you apart, packet by packet, and routes you toward ${dest.id}.`,
        "Reconnect there and you arrive as yourself -- your name, level, and standing all travel with you:",
        `    ${dest.url}`,
        "(This world is letting you go. See you on the other side.)",
      ].join(NL),
    );
    this.event(ws, "grid.travel", { to: dest.id, url: dest.url });
    try {
      ws.close(1000, "travel");
    } catch {
      /* already closing */
    }
  }

  // `war`: read the global Cinder Front vs free-folk tide, shared by every world.
  private async warReport(ws: WebSocket): Promise<void> {
    let tide = 0;
    try {
      tide = await this.env.GRID.tide();
    } catch {
      this.line(ws, "The deep Grid is silent; you can't read the war from here.");
      this.prompt(ws);
      return;
    }
    const state =
      tide <= -50
        ? "the Cinder Front is ascendant -- the free folk are being driven under, across every world at once."
        : tide >= 50
          ? "the free folk are winning -- the Front is breaking, everywhere."
          : tide < 0
            ? "the Front holds the edge, for now."
            : tide > 0
              ? "the free folk are holding their ground."
              : "the war hangs in perfect, brutal balance.";
    this.line(ws, `Across the whole Grid, the war for the wastes: ${state} (tide ${tide >= 0 ? "+" : ""}${tide})`);
    this.event(ws, "world.war", { tide });
    this.prompt(ws);
  }

  // `gridcast`: cast your voice across the entire federation -- every world hears it.
  private async gridcast(ws: WebSocket, s: Session, arg: string): Promise<void> {
    const msg = arg.trim();
    if (!msg) {
      this.line(ws, "Gridcast what? (gridcast <message> -- the dead network carries it to every world)");
      this.prompt(ws);
      return;
    }
    try {
      // Await the write: the hub is now a separate Worker reached over a service
      // binding, and a fire-and-forget RPC can be cancelled when this handler
      // returns -- so the cast must land before we move on, or the relay never
      // sees it. (As an in-Worker DO call this raced by; across the boundary it
      // doesn't.)
      await this.env.GRID.gridcast(this.worldName, s.name, msg);
    } catch {
      this.line(ws, "The Grid swallows your words; the network is unreachable.");
      this.prompt(ws);
      return;
    }
    this.line(ws, `You cast your voice into the dead Grid, out across every node: "${msg}"`);
    this.prompt(ws);
  }

  // Poll the hub for new cross-world casts and relay them to local players. Runs
  // each alarm tick; tracks the last relayed cast id in the world row.
  private async pollGridcasts(): Promise<void> {
    const since = this.ctx.storage.sql
      .exec<{ last_cast: number }>("SELECT last_cast FROM world WHERE id = 0")
      .one().last_cast;
    let casts: GridCast[] = [];
    try {
      casts = await this.env.GRID.castsSince(since, 20);
    } catch {
      return; // hub unreachable; try again next tick
    }
    if (casts.length === 0) return;
    let maxId = since;
    for (const c of casts) {
      maxId = Math.max(maxId, c.id);
      const line = `[Grid] [${c.world}] ${c.sender}: ${c.text}`;
      for (const ws of this.ctx.getWebSockets()) {
        const os = ws.deserializeAttachment() as Session | null;
        if (!os?.name) continue;
        ws.send(NL + line + NL + "> ");
        this.event(ws, "comm.gridcast", { world: c.world, from: c.sender, text: c.text });
      }
    }
    this.ctx.storage.sql.exec("UPDATE world SET last_cast = ? WHERE id = 0", maxId);
  }

  private ago(at: number): string {
    const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (sec < 60) return "moments ago";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
    const day = Math.floor(hr / 24);
    return `${day} day${day === 1 ? "" : "s"} ago`;
  }

  // `ping` the dead Grid at your node: it replays what it remembers happening
  // here, even for players long gone. The signature mechanic of The Hollow Grid.
  private async gridPing(ws: WebSocket, s: Session, arg: string): Promise<void> {
    // `ping all` / `ping deep`: reach past your own node into the whole federated
    // network -- the Grid's collective memory across every connected world.
    const a = arg.trim().toLowerCase();
    if (a === "all" || a === "deep" || a === "grid") {
      let feed: GridTrace[] = [];
      try {
        feed = await this.env.GRID.recentAcross(this.worldName, 8);
      } catch {
        this.line(ws, "You reach for the deep Grid, but the wider network is silent. (the hub is unreachable)");
        this.prompt(ws);
        return;
      }
      if (feed.length === 0) {
        this.line(ws, "The deep Grid hums, vast and empty. Nothing echoes back from the other nodes -- yet.");
      } else {
        this.line(ws, "You key past your own node, into the whole dead network. It remembers, from across the Grid:");
        for (const t of feed) this.line(ws, `  - [${t.world}] ${t.text}`);
      }
      this.event(ws, "grid.federation", { traces: feed });
      this.prompt(ws);
      return;
    }

    const rows = this.ctx.storage.sql
      .exec<{ at: number; kind: string; text: string }>(
        "SELECT at, kind, text FROM grid_log WHERE node = ? ORDER BY id DESC LIMIT 6",
        s.room,
      )
      .toArray();

    if (rows.length === 0) {
      this.line(ws, "You key into the dead Grid. Static, a cold hum... but this node remembers nothing. Not yet. (try 'ping all')");
    } else {
      this.line(ws, "You key into the dead Grid. Static, then it remembers:");
      for (const r of rows) this.line(ws, `  - ${r.text} (${this.ago(r.at)})`);
      this.line(ws, "  (say 'ping all' to hear the whole network)");
    }
    this.event(ws, "grid.echo", {
      node: s.room,
      traces: rows.map((r) => ({ at: r.at, kind: r.kind, text: r.text })),
    });
    this.prompt(ws);
  }

  // --- Server announcements (wall) ------------------------------------------
  // Keepers are configured by the ADMINS wrangler var (comma-separated names).
  private isAdmin(name: string): boolean {
    const admins = (this.env.ADMINS ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    return admins.includes(name.toLowerCase());
  }

  // `wall <message>`: a server-wide announcement that reaches every player,
  // wherever they are -- for keepers (the ADMINS var) only.
  private wall(ws: WebSocket, s: Session, arg: string): void {
    if (!this.isAdmin(s.name)) {
      this.line(ws, "Only a keeper of the Grid can broadcast across the wastes.");
      this.prompt(ws);
      return;
    }
    const msg = arg.trim();
    if (!msg) {
      this.line(ws, "Announce what?  (wall <message>)");
      this.prompt(ws);
      return;
    }
    const banner = `*** GRID BROADCAST ***  ${msg}`;
    for (const sock of this.ctx.getWebSockets()) {
      const os = sock.deserializeAttachment() as Session | null;
      if (!os?.name) continue;
      sock.send(NL + banner + NL + "> ");
      this.event(sock, "server.announce", { from: s.name, text: msg });
    }
  }

  // --- The living world: time, weather, tide, and a wandering ghost ----------
  private world(): { tick: number; phase: string; weather: string; tide: number; ghost_room: string } {
    return (
      this.ctx.storage.sql
        .exec<{ tick: number; phase: string; weather: string; tide: number; ghost_room: string }>(
          "SELECT tick, phase, weather, tide, ghost_room FROM world WHERE id = 0",
        )
        .toArray()[0] ?? { tick: 0, phase: "day", weather: "clear", tide: 0, ghost_room: START_ROOM }
    );
  }

  // Ambient broadcast to every player, wherever they are (for world events).
  private worldBroadcast(text: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name) ws.send(NL + text + NL + "> ");
    }
  }

  private emitWorldState(ws: WebSocket): void {
    const w = this.world();
    this.event(ws, "world.state", { tick: w.tick, phase: w.phase, weather: w.weather, tide: w.tide });
  }

  private emitWorldStateAll(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name) this.emitWorldState(ws);
    }
  }

  // Advance the world one tick (called from the alarm). Each change is announced
  // to everyone online and re-emitted on the structured channel, so the world
  // visibly turns without anyone touching it.
  private worldTick(): void {
    const w = this.world();
    const tick = w.tick + 1;
    let { phase, weather, tide, ghost_room } = w;
    let changed = false;

    if (tick % PHASE_TICKS === 0) {
      const idx = (PHASES as readonly string[]).indexOf(phase);
      phase = PHASES[(idx + 1) % PHASES.length];
      this.worldBroadcast(PHASE_LINE[phase]);
      changed = true;
    }

    if (tick % WEATHER_TICKS === 0) {
      const next = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];
      if (next !== weather) {
        weather = next;
        this.worldBroadcast(WEATHER_LINE[weather]);
        changed = true;
      }
    }

    // (The faction tide is global now -- driven by player choices and shared
    // across the whole federation via the Grid Hub; see contributeTide / war.)

    if (tick % GHOST_TICKS === 0) {
      ghost_room = this.driftGhost(ghost_room);
    }

    this.ctx.storage.sql.exec(
      "UPDATE world SET tick = ?, phase = ?, weather = ?, tide = ?, ghost_room = ? WHERE id = 0",
      tick,
      phase,
      weather,
      tide,
      ghost_room,
    );

    if (changed) this.emitWorldStateAll();
  }

  // The Grid-ghost drifts one room along an exit, haunting whoever's there and
  // leaving a trace -- the dead network's wanderer (ties the living world to #3).
  private driftGhost(from: string): string {
    const exits = Object.values(ROOMS[from]?.exits ?? {});
    if (exits.length === 0) return START_ROOM;
    const to = exits[Math.floor(Math.random() * exits.length)];
    this.broadcast(to, "A Grid-ghost flickers through, trailing dead static, and is gone.");
    this.recordTrace(to, "ghost", "A Grid-ghost drifted through here.");
    return to;
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
    const all = this.sessions();
    return (
      NL +
      `Survivors online (${all.length}):` +
      NL +
      (all.length ? all.map((o) => `  - ${this.tagged(o)}`).join(NL) : "  (nobody but you)") +
      NL
    );
  }

  // --- More standard MUD commands: comms, give, exits, consider --------------
  private socketByName(name: string): WebSocket | null {
    const lower = name.toLowerCase();
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.name.toLowerCase() === lower) return ws;
    }
    return null;
  }

  // Private cross-room message to one online player.
  private tell(ws: WebSocket, s: Session, arg: string): void {
    const sp = arg.indexOf(" ");
    const who = sp === -1 ? arg.trim() : arg.slice(0, sp);
    const msg = sp === -1 ? "" : arg.slice(sp + 1).trim();
    if (!who || !msg) {
      this.line(ws, "Tell whom what?  (tell <player> <message>)");
      this.prompt(ws);
      return;
    }
    const target = this.socketByName(who);
    if (!target || target === ws) {
      this.line(ws, target === ws ? "Talking to yourself is a bad sign out here." : `No one called "${who}" is online.`);
      this.prompt(ws);
      return;
    }
    const ts = target.deserializeAttachment() as Session;
    ts.replyTo = s.name;
    target.serializeAttachment(ts);
    this.line(target, `${s.name} tells you, "${msg}"`);
    this.event(target, "comm.tell", { from: s.name, text: msg });
    this.prompt(target);
    this.line(ws, `You tell ${ts.name}, "${msg}"`);
    this.prompt(ws);
  }

  private reply(ws: WebSocket, s: Session, arg: string): void {
    if (!s.replyTo) {
      this.line(ws, "You have no one to reply to.");
      this.prompt(ws);
      return;
    }
    this.tell(ws, s, `${s.replyTo} ${arg.trim()}`);
  }

  // A free-form emote to the room: "Name <action>".
  private emote(ws: WebSocket, s: Session, arg: string): void {
    const action = arg.trim();
    if (!action) {
      this.line(ws, "Emote what?  (emote <action>, e.g. emote spits in the dust)");
      this.prompt(ws);
      return;
    }
    this.broadcast(s.room, `${s.name} ${action}`, ws);
    this.line(ws, `${s.name} ${action}`);
    this.prompt(ws);
  }

  // Server-wide PLAYER chat (distinct from the admin `wall`).
  private yell(ws: WebSocket, s: Session, arg: string): void {
    const msg = arg.trim();
    if (!msg) {
      this.line(ws, "Yell what?  (yell <message>)");
      this.prompt(ws);
      return;
    }
    for (const sock of this.ctx.getWebSockets()) {
      const os = sock.deserializeAttachment() as Session | null;
      if (!os?.name) continue;
      sock.send(NL + (sock === ws ? `You yell, "${msg}"` : `${s.name} yells, "${msg}"`) + NL + "> ");
      this.event(sock, "comm.yell", { from: s.name, text: msg });
    }
  }

  // Hand an item to another player in the same room.
  private give(ws: WebSocket, s: Session, arg: string): void {
    const toks = arg.trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2) {
      this.line(ws, "Give what to whom?  (give <item> <player>)");
      this.prompt(ws);
      return;
    }
    const who = toks[toks.length - 1];
    let itemToks = toks.slice(0, -1);
    if (itemToks[itemToks.length - 1]?.toLowerCase() === "to") itemToks = itemToks.slice(0, -1);
    const itemArg = itemToks.join(" ");
    const item = this.invItems(s.name).find((id) => itemMatches(id, itemArg));
    if (!item) {
      this.line(ws, `You aren't carrying "${itemArg}".`);
      this.prompt(ws);
      return;
    }
    const target = this.socketByName(who);
    const ts = target ? (target.deserializeAttachment() as Session | null) : null;
    if (!target || target === ws || !ts || ts.room !== s.room) {
      this.line(ws, `There's no one called "${who}" here to give it to.`);
      this.prompt(ws);
      return;
    }
    this.invRemove(s.name, item, 1);
    this.invAdd(ts.name, item, 1);
    const itemName = ITEM_TEMPLATES[item].name;
    this.line(ws, `You give ${itemName} to ${ts.name}.`);
    this.prompt(ws);
    this.line(target, `${s.name} gives you ${itemName}.`);
    this.prompt(target);
  }

  private exitsView(ws: WebSocket, s: Session): void {
    const exits = Object.keys(ROOMS[s.room].exits);
    this.line(ws, exits.length ? `Exits: ${exits.join(", ")}.` : "There are no obvious exits from here.");
    this.prompt(ws);
  }

  // Size up a mob before committing to a fight.
  private consider(ws: WebSocket, s: Session, arg: string): void {
    if (!arg.trim()) {
      this.line(ws, "Consider what?  (consider <mob>)");
      this.prompt(ws);
      return;
    }
    const mob = this.livingMobsInRoom(s.room).find((m) => this.mobMatches(m.id, arg));
    if (!mob) {
      this.line(ws, `There's no "${arg}" here to size up.`);
      this.prompt(ws);
      return;
    }
    const t = MOB_BY_ID[mob.id];
    const ratio = (t.maxHp + t.maxDmg * 5) / (s.maxHp + s.level * 10);
    const verdict =
      ratio < 0.4
        ? `You could put ${t.name} down without breaking a sweat.`
        : ratio < 0.8
          ? `${cap(t.name)} would give you a tussle, but the odds are yours.`
          : ratio < 1.2
            ? `${cap(t.name)} looks like an even match. Bring an antidote.`
            : ratio < 2
              ? `${cap(t.name)} would likely gut you. Think twice.`
              : `Attacking ${t.name} would be a quiet way to die.`;
    this.line(ws, verdict);
    this.prompt(ws);
  }

  // look (no arg = the room; otherwise a player here, then a mob, then items).
  private lookAt(ws: WebSocket, s: Session, arg: string): void {
    if (!arg.trim()) {
      this.sendRoom(ws, s);
      this.prompt(ws);
      return;
    }
    const a = arg.trim().toLowerCase();
    const other = this.sessions().find(
      (o) => o.room === s.room && o.name !== s.name && o.name.toLowerCase().startsWith(a),
    );
    if (other) {
      const pos = (other.position ?? "standing") !== "standing" ? `, ${other.position}` : "";
      this.line(ws, `${this.tagged(other)} stands before you${pos}, looking ${condition(other)}.`);
      this.prompt(ws);
      return;
    }
    const mob = this.livingMobsInRoom(s.room).find((m) => this.mobMatches(m.id, arg));
    if (mob) {
      this.line(ws, MOB_BY_ID[mob.id].desc);
      this.prompt(ws);
      return;
    }
    this.examine(ws, s, arg); // fall through to items (inventory or ground)
  }

  // recall / home: the Grid pulls you back to the Cracked Nexus.
  private recall(ws: WebSocket, s: Session): void {
    if (s.target) {
      this.line(ws, "You can't recall in the middle of a fight.");
      this.prompt(ws);
      return;
    }
    if (s.room === START_ROOM) {
      this.line(ws, "You're already at the Cracked Nexus.");
      this.prompt(ws);
      return;
    }
    const from = s.room;
    this.broadcast(from, `${s.name} dissolves into grid-static and is gone.`, ws);
    s.room = START_ROOM;
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.recordTrace(from, "recall", `${this.tagged(s)} keyed out on the Grid from here.`);
    this.line(ws, "You key the recall. The Grid takes hold, the world smears, and resolves at the Cracked Nexus.");
    this.broadcast(START_ROOM, `${s.name} resolves out of the static.`, ws);
    this.sendRoom(ws, s);
    this.prompt(ws);
  }

  // affects: list what is currently working on you.
  private affects(ws: WebSocket, s: Session): void {
    const lines = ["You are affected by:"];
    if (s.poisoned) lines.push("  Poisoned       venom drains your HP every tick.");
    if (s.addiction > 0)
      lines.push(`  Dust craving   addiction at ${s.addiction}${s.addiction >= 3 ? " (your hands won't stop shaking)" : ""}.`);
    if (s.faction === "front") lines.push("  Cinder Front   you marched against the free folk; they remember.");
    if (s.faction === "ally") lines.push("  Free Folk ally the elves count you a friend.");
    const pos = s.position ?? "standing";
    if (pos === "resting" || pos === "sleeping") lines.push(`  ${cap(pos)}        recovering HP each tick.`);
    if (lines.length === 1) lines.push("  ...nothing in particular. You feel clear, for once.");
    this.line(ws, lines.join(NL));
    this.emitAffects(ws, s);
    this.prompt(ws);
  }

  // rest / sleep / sit / stand / wake.
  private setPosition(ws: WebSocket, s: Session, pos: string): void {
    if (s.target && pos !== "standing") {
      this.line(ws, "Not in the middle of a fight, you don't.");
      this.prompt(ws);
      return;
    }
    if ((s.position ?? "standing") === pos) {
      this.line(ws, `You're ${POS_ALREADY[pos]}.`);
      this.prompt(ws);
      return;
    }
    s.position = pos;
    ws.serializeAttachment(s);
    this.line(ws, POS_SELF[pos]);
    this.broadcast(s.room, `${s.name} ${POS_OTHERS[pos]}.`, ws);
    this.emitVitals(ws, s);
    this.prompt(ws);
  }

  // --- Equipment: worn gear with stat bonuses --------------------------------
  private equipped(player: string): Record<string, string> {
    const rows = this.ctx.storage.sql
      .exec<{ slot: string; item: string }>("SELECT slot, item FROM equipment WHERE player = ?", player)
      .toArray();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.slot] = r.item;
    return out;
  }

  private equipBonuses(player: string): { damage: number; armor: number } {
    let damage = 0;
    let armor = 0;
    for (const item of Object.values(this.equipped(player))) {
      const t = ITEM_TEMPLATES[item];
      if (t?.damage) damage += t.damage;
      if (t?.armor) armor += t.armor;
    }
    return { damage, armor };
  }

  private emitEquipment(ws: WebSocket, player: string): void {
    const eq = this.equipped(player);
    this.event(ws, "char.equipment", Object.fromEntries(EQUIP_SLOTS.map((sl) => [sl, eq[sl] ?? null])));
  }

  // wear / wield / equip: move an item from inventory into its slot.
  private equip(ws: WebSocket, s: Session, arg: string): void {
    if (!arg.trim()) {
      this.line(ws, "Wear or wield what?  (equip <item>)");
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
    if (!t.slot) {
      this.line(ws, `You can't wear or wield ${t.name}.`);
      this.prompt(ws);
      return;
    }
    const current = this.equipped(s.name)[t.slot];
    if (current) {
      // Swap: stow whatever's already in that slot.
      this.invAdd(s.name, current, 1);
      this.ctx.storage.sql.exec("DELETE FROM equipment WHERE player = ? AND slot = ?", s.name, t.slot);
    }
    this.invRemove(s.name, item, 1);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO equipment (player, slot, item) VALUES (?, ?, ?)", s.name, t.slot, item);
    const verb = t.slot === "weapon" ? "wield" : "wear";
    this.line(ws, `You ${verb} ${t.name}.${current ? ` (You stop using ${ITEM_TEMPLATES[current].name}.)` : ""}`);
    this.broadcast(s.room, `${s.name} ${verb}s ${t.name}.`, ws);
    this.emitEquipment(ws, s.name);
    this.prompt(ws);
  }

  // remove / unwield: move an equipped item back to inventory.
  private unequip(ws: WebSocket, s: Session, arg: string): void {
    if (!arg.trim()) {
      this.line(ws, "Remove what?  (remove <item>)");
      this.prompt(ws);
      return;
    }
    const eq = this.equipped(s.name);
    const slot = Object.keys(eq).find((sl) => itemMatches(eq[sl], arg));
    if (!slot) {
      this.line(ws, `You aren't using any "${arg}".`);
      this.prompt(ws);
      return;
    }
    const item = eq[slot];
    this.ctx.storage.sql.exec("DELETE FROM equipment WHERE player = ? AND slot = ?", s.name, slot);
    this.invAdd(s.name, item, 1);
    this.line(ws, `You remove ${ITEM_TEMPLATES[item].name} and stow it.`);
    this.emitEquipment(ws, s.name);
    this.prompt(ws);
  }

  // equipment / eq: show what's worn and the bonuses it grants.
  private equipmentView(ws: WebSocket, s: Session): void {
    const eq = this.equipped(s.name);
    const lines = ["You are using:"];
    for (const sl of EQUIP_SLOTS) {
      lines.push(`  ${sl.padEnd(7)} ${eq[sl] ? ITEM_TEMPLATES[eq[sl]].name : "(nothing)"}`);
    }
    const b = this.equipBonuses(s.name);
    lines.push(`  -- in total: +${b.damage} damage, +${b.armor} armor`);
    this.line(ws, lines.join(NL));
    this.emitEquipment(ws, s.name);
    this.prompt(ws);
  }

  // title <text>: a custom epithet shown after your name (blank to clear).
  private setTitle(ws: WebSocket, s: Session, arg: string): void {
    const t = arg.trim().replace(/[\r\n]/g, "").slice(0, 40);
    s.title = t;
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.commitIdentity(s);
    if (t) this.line(ws, `You are known henceforth as ${s.name}, ${t}.`);
    else this.line(ws, `Your title is stripped away. Just ${s.name} now.`);
    this.prompt(ws);
  }

  private help(): string {
    return (
      [
        "",
        "Commands:",
        "  look (l) [target]     describe the room, or a player/mob/item",
        "  north/south/...       move (n s e w ne nw se sw u d, or 'go <dir>')",
        "  exits                 list the ways out of this room",
        "  recall / home         key back to the Cracked Nexus",
        "  attack <mob> (k)      start a fight (resolves every few seconds)",
        "  consider <mob> (con)  size up a fight before you start it",
        "  flee (f)              break off combat",
        "  get/take <item>       pick something up off the ground",
        "  drop <item>           drop an item",
        "  give <item> <player>  hand an item to someone in your room",
        "  inventory (inv, i)    list what you're carrying",
        "  wear/wield <item>     equip gear (weapons add damage, armor soaks hits)",
        "  remove <item>         take off a piece of gear",
        "  equipment (eq)        show what you're wearing and wielding",
        "  use/drink <item>      use an item (antidote, rad-cell, ...)",
        "  examine <item>        look closely at an item",
        "  free/rescue           free the captive (in the Holding Pit)",
        "  sell <item>           sell salvage to the market vendor (honest coin)",
        "  steal                 lift gold from the market stall (risky, corrupting)",
        "  buy <item>            buy from a vendor (dust at the Tankard; gear at the Workshop)",
        "  list                  list a shop's wares (the Tinker's Workshop)",
        "  carouse / resist      indulge or refuse the Tankard's vices",
        "  join / defend         side with the Cinder Front, or the elves (Scrap Market)",
        "  talk                  speak to whoever shares your room",
        "  hp / status           show health, level, xp, gold, and standing",
        "  affects (affs)        list what's currently affecting you",
        "  rest/sleep/sit/stand  change position (resting and sleeping heal you)",
        "  say <message> (')     speak to everyone in the room",
        "  tell <player> <msg>   private message (reply with 'reply <msg>')",
        "  yell <message>        shout to everyone online",
        "  emote <action>        act it out ('emote spits in the dust')",
        "  who                   list survivors online",
        "  title <text>          set an epithet shown after your name (blank clears it)",
        "  ping [all]            query this node's Grid memory ('ping all' = the whole network)",
        "  gridcast <message>    speak across EVERY world on the Grid (gc)",
        "  war / tide            the global Cinder Front vs free-folk war (all worlds)",
        "  whoami                your canonical self on the Grid (follows you everywhere)",
        "  worlds                list the worlds linked on the Grid",
        "  travel <world>        cross the Grid to another world (your character follows)",
        "  wall <message>        broadcast an announcement to everyone (keepers only)",
        "  world / weather       check the time of day and the weather",
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
      `INSERT INTO players (name, room, hp, max_hp, xp, level, poisoned, gold, morality, addiction, faction, resisted, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         room = excluded.room, hp = excluded.hp, max_hp = excluded.max_hp,
         xp = excluded.xp, level = excluded.level, poisoned = excluded.poisoned,
         gold = excluded.gold, morality = excluded.morality, addiction = excluded.addiction,
         faction = excluded.faction, resisted = excluded.resisted, title = excluded.title`,
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
      s.title ?? "",
    );
  }
}
