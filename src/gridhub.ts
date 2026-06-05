import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

// The Grid Hub: the federation backend (phase 1, the shared Grid ledger).
//
// A single global Durable Object (getByName("grid")) that holds the dead
// network's COLLECTIVE memory -- traces from every connected world, tagged with
// the world they came from. Worlds report notable events here (best-effort,
// never blocking local play), and any world can read the federation feed back:
// `ping all` hears echoes from across the whole network, not just your own node.
//
// This needs no trust machinery -- traces are lore, not progression -- which is
// why it's the first federation piece. Today it lives in the same Worker as the
// world; extracting it to a dedicated backend Worker behind a service binding is
// the step that lets SEPARATE deployments share it (see docs/federation.md).

export type GridTrace = {
  world: string;
  node: string;
  kind: string;
  text: string;
  at: number;
};

export type GridCast = { id: number; world: string; sender: string; text: string };

// The canonical, federation-wide character: the progression + standing that
// follows a player across every world. Local-only state (room, hp, position,
// inventory) is NOT here -- worlds own that. (See docs/federation.md.)
export type CharSheet = {
  level: number;
  xp: number;
  gold: number;
  faction: string;
  morality: number;
  title: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// A world on the federation: its name, where to connect, and when it last
// checked in (for liveness). Players `travel` between these.
export type WorldInfo = { id: string; url: string; last_seen: number };

// Notional sibling worlds, so the federation feels populated before others
// actually connect. (A real world overwrites its entry when it registers.)
const SEED_WORLDS: { id: string; url: string }[] = [
  { id: "Saltreach", url: "wss://saltreach.example/ws" },
  { id: "the Ninth Server", url: "wss://ninth-server.example/ws" },
  { id: "Dustfall", url: "wss://dustfall.example/ws" },
];

// Echoes seeded from "elsewhere on the Grid" so the federation feed is alive on
// the very first ping, before any other world has actually connected. (Once real
// worlds report in, their traces interleave with these.)
const SEED_ECHOES: Omit<GridTrace, "at">[] = [
  { world: "Saltreach", node: "the drowned pier", kind: "death", text: "a runner called Mox bled out, cursing the tide." },
  { world: "the Ninth Server", node: "cell block C", kind: "oath", text: "someone swore off the dust for the ninth time." },
  { world: "Dustfall", node: "the long market", kind: "slain", text: "a trader put down a chrome-jackal with a length of pipe." },
];

export class GridHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          world TEXT NOT NULL,
          node TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          at INTEGER NOT NULL
        )
      `);
      const count = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM ledger").one().c;
      if (count === 0) {
        for (const e of SEED_ECHOES) {
          sql.exec("INSERT INTO ledger (world, node, kind, text, at) VALUES (?, ?, ?, ?, 0)", e.world, e.node, e.kind, e.text);
        }
      }

      // The global faction tide: one needle the whole federation moves.
      // Negative = the Cinder Front ascendant; positive = the free folk rising.
      sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
      sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('tide', 0)");

      // Cross-world chat: a shared feed worlds poll and relay to their players.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS casts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          world TEXT NOT NULL,
          sender TEXT NOT NULL,
          text TEXT NOT NULL,
          at INTEGER NOT NULL
        )
      `);

      // Canonical character sheets: the federation owns progression + standing,
      // so a character is the same person in every world (phase 3).
      sql.exec(`
        CREATE TABLE IF NOT EXISTS characters (
          name TEXT PRIMARY KEY,
          level INTEGER NOT NULL DEFAULT 1,
          xp INTEGER NOT NULL DEFAULT 0,
          gold INTEGER NOT NULL DEFAULT 20,
          faction TEXT NOT NULL DEFAULT 'none',
          morality INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL DEFAULT ''
        )
      `);

      // The world registry (phase 4): who's on the Grid, and where to reach them.
      sql.exec("CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, url TEXT NOT NULL, last_seen INTEGER NOT NULL)");
      const worldCount = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM worlds").one().c;
      if (worldCount === 0) {
        for (const w of SEED_WORLDS) {
          sql.exec("INSERT INTO worlds (id, url, last_seen) VALUES (?, ?, 0)", w.id, w.url);
        }
      }
    });
  }

  // A world reports a notable event into the shared Grid memory. RPC-callable.
  record(world: string, node: string, kind: string, text: string, at: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO ledger (world, node, kind, text, at) VALUES (?, ?, ?, ?, ?)", world, node, kind, text, at);
    // Keep the collective memory long but bounded.
    sql.exec("DELETE FROM ledger WHERE id NOT IN (SELECT id FROM ledger ORDER BY id DESC LIMIT 1000)");
  }

  // The federation feed: the most recent traces from across the whole network.
  recent(limit: number): GridTrace[] {
    return this.ctx.storage.sql
      .exec<GridTrace>("SELECT world, node, kind, text, at FROM ledger ORDER BY id DESC LIMIT ?", Math.max(1, Math.min(limit, 50)))
      .toArray();
  }

  // The federation feed as heard FROM a given world: newest traces overall, but
  // with slots reserved for OTHER worlds so the rest of the Grid is always
  // audible even when your own world is the noisiest node on the network. (A
  // plain `recent()` drowns in local traces once a world gets busy; the whole
  // point of `ping all` is to hear past your own node.)
  recentAcross(world: string, limit: number): GridTrace[] {
    const sql = this.ctx.storage.sql;
    const lim = clamp(Math.floor(limit), 1, 50);
    const foreignQuota = Math.min(3, lim);
    const foreign = sql
      .exec<GridTrace>("SELECT world, node, kind, text, at FROM ledger WHERE world != ? ORDER BY id DESC LIMIT ?", world, foreignQuota)
      .toArray();
    const overall = sql
      .exec<GridTrace>("SELECT world, node, kind, text, at FROM ledger ORDER BY id DESC LIMIT ?", lim)
      .toArray();
    const key = (t: GridTrace) => `${t.world}|${t.node}|${t.text}|${t.at}`;
    const seen = new Set(foreign.map(key));
    const out = [...foreign];
    for (const t of overall) {
      if (out.length >= lim) break;
      if (seen.has(key(t))) continue;
      seen.add(key(t));
      out.push(t);
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // --- The global faction tide (shared mutable state across all worlds) ------
  tide(): number {
    return this.ctx.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'tide'").one().v;
  }

  shiftTide(delta: number): number {
    const next = Math.max(-100, Math.min(100, this.tide() + delta));
    this.ctx.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'tide'", next);
    return next;
  }

  // --- Cross-world chat ------------------------------------------------------
  gridcast(world: string, sender: string, text: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO casts (world, sender, text, at) VALUES (?, ?, ?, ?)", world, sender, text, Date.now());
    sql.exec("DELETE FROM casts WHERE id NOT IN (SELECT id FROM casts ORDER BY id DESC LIMIT 200)");
  }

  // Worlds poll this each tick for casts newer than the last one they relayed.
  castsSince(sinceId: number, limit: number): GridCast[] {
    return this.ctx.storage.sql
      .exec<GridCast>("SELECT id, world, sender, text FROM casts WHERE id > ? ORDER BY id ASC LIMIT ?", sinceId, Math.max(1, Math.min(limit, 50)))
      .toArray();
  }

  // --- Canonical identity (phase 3): the character that follows you ----------
  loadCharacter(name: string): CharSheet {
    const row = this.ctx.storage.sql
      .exec<CharSheet>("SELECT level, xp, gold, faction, morality, title FROM characters WHERE name = ?", name)
      .toArray()[0];
    if (row) return row;
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO characters (name, level, xp, gold, faction, morality, title) VALUES (?, 1, 0, 20, 'none', 0, '')",
      name,
    );
    return { level: 1, xp: 0, gold: 20, faction: "none", morality: 0, title: "" };
  }

  // A world PROPOSES a character sheet; the hub VALIDATES it against bounds and
  // commits the result. This is the trust boundary: honest worlds pass, a cheaty
  // world's absurd deltas get clamped (no de-leveling, no implausible jumps, no
  // minting gold). Returns the committed (possibly clamped) sheet.
  commitCharacter(name: string, p: CharSheet): CharSheet {
    const cur = this.loadCharacter(name);
    const next: CharSheet = {
      level: clamp(Math.floor(p.level), cur.level, cur.level + 5), // never de-level; no big jumps
      xp: Math.max(0, Math.floor(p.xp)),
      gold: clamp(Math.floor(p.gold), 0, cur.gold + 1_000_000), // no minting absurd gold
      faction: ["none", "front", "ally"].includes(p.faction) ? p.faction : cur.faction,
      morality: clamp(Math.floor(p.morality), -1000, 1000),
      title: String(p.title ?? "").replace(/[\r\n]/g, "").slice(0, 40),
    };
    this.ctx.storage.sql.exec(
      "UPDATE characters SET level = ?, xp = ?, gold = ?, faction = ?, morality = ?, title = ? WHERE name = ?",
      next.level,
      next.xp,
      next.gold,
      next.faction,
      next.morality,
      next.title,
      name,
    );
    return next;
  }

  // --- The world registry (phase 4): travel destinations --------------------
  register(world: string, url: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO worlds (id, url, last_seen) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET url = excluded.url, last_seen = excluded.last_seen",
      world,
      url,
      Date.now(),
    );
  }

  listWorlds(): WorldInfo[] {
    return this.ctx.storage.sql
      .exec<WorldInfo>("SELECT id, url, last_seen FROM worlds ORDER BY last_seen DESC, id ASC")
      .toArray();
  }
}
