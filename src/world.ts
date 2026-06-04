import { DurableObject } from "cloudflare:workers";
import type { Env, Session } from "./types";
import { ROOMS, START_ROOM, normalizeDir } from "./rooms";

const NL = "\r\n"; // wscat / telnet-style clients render CRLF cleanly

/**
 * World — a single Durable Object that holds the whole game. Every player
 * connects to the same instance (routed via `getByName("world")`), so they
 * share one coordinated view of the world.
 *
 * Connections use the WebSocket Hibernation API: sockets are accepted with
 * `ctx.acceptWebSocket`, per-player state rides on the socket attachment, and
 * room membership is derived by scanning `ctx.getWebSockets()`. That means the
 * DO can hibernate (stop being billed for duration) while players stay
 * connected, and wake up with everything intact.
 *
 * Scaling note: one global DO is the right starting point for a MUD and is fine
 * up to a few hundred concurrent players. If you outgrow it, shard by zone
 * (one DO per area) and add cross-DO messaging for movement + global chat.
 */
export class World extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema setup only — keep blockConcurrencyWhile cheap and synchronous.
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS players (
          name TEXT PRIMARY KEY,
          room TEXT NOT NULL
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

    // Not logged in yet; the first line they send becomes their name.
    const session: Session = { name: "", room: "" };
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

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const line = (typeof message === "string" ? message : new TextDecoder().decode(message)).trim();
    const session = ws.deserializeAttachment() as Session | null;

    if (!session || !session.name) {
      this.handleLogin(ws, line);
      return;
    }
    this.handleCommand(ws, session, line);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const session = ws.deserializeAttachment() as Session | null;
    if (session?.name) {
      this.broadcast(session.room, `${session.name} flickers out of existence.`, ws);
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closing; nothing to do
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

    // Resume the player's last room if we've seen them before.
    const rows = this.ctx.storage.sql
      .exec<{ room: string }>("SELECT room FROM players WHERE name = ?", name)
      .toArray();
    let room = rows.length ? rows[0].room : START_ROOM;
    if (!ROOMS[room]) room = START_ROOM; // map may have changed since last visit

    const session: Session = { name, room };
    ws.serializeAttachment(session);
    this.persist(name, room);

    ws.send(`Welcome to the wastes, ${name}.` + NL);
    this.broadcast(room, `${name} steps out of the haze.`, ws);
    ws.send(this.describeRoom(session));
    ws.send(this.prompt());
  }

  // ---- command handling ----------------------------------------------------

  private handleCommand(ws: WebSocket, session: Session, line: string): void {
    if (line.length === 0) {
      ws.send(this.prompt());
      return;
    }

    const [word, ...rest] = line.split(/\s+/);
    const cmd = word.toLowerCase();
    const arg = rest.join(" ");

    const dir = normalizeDir(cmd);
    if (dir) {
      this.move(ws, session, dir);
      return;
    }

    switch (cmd) {
      case "look":
      case "l":
        ws.send(this.describeRoom(session));
        break;
      case "go":
        this.handleGo(ws, session, arg);
        break;
      case "say":
      case "'":
        this.say(ws, session, arg);
        break;
      case "who":
        ws.send(this.who());
        break;
      case "help":
      case "?":
        ws.send(this.help());
        break;
      case "quit":
        ws.send("You step back into the haze. Stay alive out there." + NL);
        this.broadcast(session.room, `${session.name} flickers out of existence.`, ws);
        ws.close(1000, "quit");
        return;
      default:
        ws.send(`I don't understand "${cmd}". Try "help".` + NL);
        break;
    }
    ws.send(this.prompt());
  }

  private handleGo(ws: WebSocket, session: Session, arg: string): void {
    const dir = normalizeDir(arg);
    if (!dir) {
      ws.send('Go where? Try a direction like "go north".' + NL);
      return;
    }
    this.move(ws, session, dir);
  }

  private move(ws: WebSocket, session: Session, dir: string): void {
    const room = ROOMS[session.room];
    const destId = room.exits[dir];
    if (!destId) {
      ws.send(`You can't go ${dir} from here.` + NL);
      ws.send(this.prompt());
      return;
    }

    this.broadcast(session.room, `${session.name} heads ${dir}.`, ws);

    session.room = destId;
    ws.serializeAttachment(session);
    this.persist(session.name, destId);

    this.broadcast(destId, `${session.name} arrives.`, ws);
    ws.send(this.describeRoom(session));
    ws.send(this.prompt());
  }

  private say(ws: WebSocket, session: Session, message: string): void {
    if (!message) {
      ws.send("Say what?" + NL);
      return;
    }
    ws.send(`You say, "${message}"` + NL);
    this.broadcast(session.room, `${session.name} says, "${message}"`, ws);
  }

  // ---- views ---------------------------------------------------------------

  private describeRoom(session: Session): string {
    const room = ROOMS[session.room];
    const lines = [room.name, room.desc];

    const exits = Object.keys(room.exits);
    lines.push(exits.length ? `Exits: ${exits.join(", ")}.` : "There are no obvious exits.");

    const others = this.playersInRoom(session.room).filter((n) => n !== session.name);
    if (others.length) {
      lines.push(`Also here: ${others.join(", ")}.`);
    }

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
        "  say <message> (')   speak to everyone in the room",
        "  who                 list survivors currently online",
        "  help (?)            this message",
        "  quit                disconnect",
      ].join(NL) + NL
    );
  }

  private prompt(): string {
    return "> ";
  }

  // ---- helpers -------------------------------------------------------------

  /** Live sockets are the source of truth for who is online and where. */
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

  private broadcast(roomId: string, text: string, exclude?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.room === roomId) {
        ws.send(NL + text + NL + this.prompt());
      }
    }
  }

  private persist(name: string, room: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO players (name, room) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET room = excluded.room",
      name,
      room,
    );
  }
}
