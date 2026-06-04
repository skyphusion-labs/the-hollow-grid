import { DurableObject } from "cloudflare:workers";
import type { Env, Session } from "./types";
import { ROOMS, START_ROOM, normalizeDir } from "./rooms";
import { MOB_TEMPLATES, MOB_BY_ID } from "./mobs";

const NL = "\r\n"; // wscat / telnet-style clients render CRLF cleanly

const ROUND_MS = 3_000; // combat resolves one round every 3 seconds
const BASE_HP = 30;

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
 * World — a single Durable Object that holds the whole game. Every player
 * connects to the same instance (routed via `getByName("world")`), so they
 * share one coordinated view of the world.
 *
 * Connections use the WebSocket Hibernation API: sockets are accepted with
 * `ctx.acceptWebSocket`, per-player state rides on the socket attachment, and
 * room membership is derived by scanning `ctx.getWebSockets()`.
 *
 * Combat is driven by a Durable Object **alarm**: while any player is in a
 * fight (or a slain mob is waiting to respawn) the DO schedules an alarm. Each
 * `alarm()` tick respawns due mobs and resolves one combat round per active
 * fight, then reschedules itself until there's nothing left to do — at which
 * point the DO can hibernate. All mob state and player vitals live in SQLite,
 * so a tick still works correctly after the DO has been evicted from memory.
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
          level INTEGER NOT NULL DEFAULT 1
        )
      `);
      // Upgrade older player tables (skeleton had only name + room).
      for (const col of [
        `hp INTEGER NOT NULL DEFAULT ${BASE_HP}`,
        `max_hp INTEGER NOT NULL DEFAULT ${BASE_HP}`,
        "xp INTEGER NOT NULL DEFAULT 0",
        "level INTEGER NOT NULL DEFAULT 1",
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
      // Seed one mob instance per template if we haven't already.
      for (const t of MOB_TEMPLATES) {
        sql.exec(
          "INSERT OR IGNORE INTO mobs (id, room, hp, max_hp, state, respawn_at) VALUES (?, ?, ?, ?, 'alive', 0)",
          t.template,
          t.room,
          t.maxHp,
          t.maxHp,
        );
      }
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

    const session: Session = { name: "", room: "", hp: BASE_HP, maxHp: BASE_HP, xp: 0, level: 1, target: null };
    server.serializeAttachment(session);

    server.send(
      [
        "",
        "================================================================",
        "  THE CHROME WASTES  —  a MUD on Cloudflare Workers",
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

  // ---- alarm: combat + respawns -------------------------------------------

  async alarm(): Promise<void> {
    const now = Date.now();

    // 1) Respawn any mobs whose timer is up.
    const due = this.ctx.storage.sql
      .exec<MobRow>("SELECT * FROM mobs WHERE state = 'dead' AND respawn_at <= ?", now)
      .toArray();
    for (const m of due) {
      this.ctx.storage.sql.exec(
        "UPDATE mobs SET state = 'alive', hp = max_hp WHERE id = ?",
        m.id,
      );
      const t = MOB_BY_ID[m.id];
      this.broadcast(m.room, `${cap(t.name)} stalks into view.`);
    }

    // 2) Resolve one round per active fight. Deserialize at processing time so
    //    targets cleared by an earlier kill this tick are seen as cleared.
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.target) {
        this.resolveRound(ws, s);
      }
    }

    await this.scheduleNextTick();
  }

  /** Schedule the next alarm only if there's combat or a pending respawn. */
  private async scheduleNextTick(): Promise<void> {
    const now = Date.now();
    let next = Infinity;

    const fighting = this.ctx
      .getWebSockets()
      .some((ws) => (ws.deserializeAttachment() as Session | null)?.target);
    if (fighting) next = Math.min(next, now + ROUND_MS);

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

    // Mob hits back.
    const mdmg = rand(t.minDmg, t.maxDmg);
    s.hp = Math.max(0, s.hp - mdmg);
    this.line(ws, `${cap(t.name)} hits you for ${mdmg}. (HP ${s.hp}/${s.maxHp})`);

    if (s.hp <= 0) {
      this.killPlayer(ws, s);
      return;
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
      .exec<{ room: string; hp: number; max_hp: number; xp: number; level: number }>(
        "SELECT room, hp, max_hp, xp, level FROM players WHERE name = ?",
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
    };
    if (session.hp <= 0) session.hp = session.maxHp; // never resume dead
    ws.serializeAttachment(session);
    this.persistPlayer(session);

    ws.send(`Welcome to the wastes, ${name}.` + NL);
    this.broadcast(room, `${name} steps out of the haze.`, ws);
    ws.send(this.describeRoom(session));
    this.prompt(ws);
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
      case "hp":
      case "status":
      case "st":
        this.line(ws, `HP ${s.hp}/${s.maxHp}   Level ${s.level}   XP ${s.xp}/${s.level * 100}`);
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
    await this.scheduleNextTick(); // wake the combat loop
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

  private say(ws: WebSocket, s: Session, message: string): void {
    if (!message) {
      this.line(ws, "Say what?");
      return;
    }
    this.line(ws, `You say, "${message}"`);
    this.broadcast(s.room, `${s.name} says, "${message}"`, ws);
  }

  // ---- views ---------------------------------------------------------------

  private describeRoom(s: Session): string {
    const room = ROOMS[s.room];
    const lines = [room.name, room.desc];

    const exits = Object.keys(room.exits);
    lines.push(exits.length ? `Exits: ${exits.join(", ")}.` : "There are no obvious exits.");

    const mobs = this.livingMobsInRoom(s.room).map((m) => MOB_BY_ID[m.id].name);
    if (mobs.length) lines.push(`You see: ${mobs.join(", ")}.`);

    const others = this.playersInRoom(s.room).filter((n) => n !== s.name);
    if (others.length) lines.push(`Also here: ${others.join(", ")}.`);

    return NL + lines.join(NL) + NL;
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
        "  look (l)            describe your surroundings",
        "  north/south/...     move (n s e w ne nw se sw u d, or 'go <dir>')",
        "  attack <mob> (k)    start a fight (combat resolves every few seconds)",
        "  flee (f)            break off combat",
        "  hp / status         show your health, level, and xp",
        "  say <message> (')   speak to everyone in the room",
        "  who                 list survivors currently online",
        "  help (?)            this message",
        "  quit                disconnect",
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

  private broadcast(roomId: string, text: string, exclude?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.room === roomId) {
        ws.send(NL + text + NL + "> ");
      }
    }
  }

  private persistPlayer(s: Session): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO players (name, room, hp, max_hp, xp, level)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         room = excluded.room, hp = excluded.hp, max_hp = excluded.max_hp,
         xp = excluded.xp, level = excluded.level`,
      s.name,
      s.room,
      s.hp,
      s.maxHp,
      s.xp,
      s.level,
    );
  }
}
