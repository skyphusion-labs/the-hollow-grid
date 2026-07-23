import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import type { GridTrace, GridCast, CharSheet, WorldInfo, Fallen, Rescued, Presence } from "../../shared/grid";

// The Grid Hub: the federation's shared state, as a single global Durable Object
// (getByName("grid")). It holds the dead network's COLLECTIVE memory -- traces,
// the faction tide, cross-world chat, canonical character sheets, and the world
// registry -- tagged by the world each piece came from.
//
// This DO now lives in its OWN backend Worker (grid-hub). The thin WorkerEntrypoint
// in index.ts exposes these methods over a service binding, so SEPARATE world
// deployments can all bind this one backend and share a single Grid. The data
// shapes are defined once in shared/grid.ts (the federation contract).
// (See docs/federation.md.)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Per-commit caps on progression deltas (K3 #86: spam +1M gold minting).
const MAX_GOLD_DELTA = 10_000;
const MAX_XP_DELTA = 10_000;
const MAX_LEVEL_DELTA = 5;

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
      // so a character is the same person in every world.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS characters (
          name TEXT PRIMARY KEY,
          level INTEGER NOT NULL DEFAULT 1,
          xp INTEGER NOT NULL DEFAULT 0,
          gold INTEGER NOT NULL DEFAULT 20,
          faction TEXT NOT NULL DEFAULT 'none',
          morality INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL DEFAULT '',
          home_world TEXT NOT NULL DEFAULT '',
          lease_world TEXT NOT NULL DEFAULT ''
        )
      `);
      // race: an opaque, federated label (the hub never gatekeeps it, so any world
      // can define races). ashsworn: the permanent kapo brand (write-once true).
      for (const col of [
        "race TEXT NOT NULL DEFAULT ''",
        "ashsworn INTEGER NOT NULL DEFAULT 0",
        "home_world TEXT NOT NULL DEFAULT ''",
        "lease_world TEXT NOT NULL DEFAULT ''",
      ]) {
        try {
          sql.exec(`ALTER TABLE characters ADD COLUMN ${col}`);
        } catch {
          // column already exists
        }
      }

      // The memorial roll: the fallen across the Grid, kept so the living can
      // refuse to forget them (`witness`). The name is stored directly, never
      // parsed from prose, so a vigil names the dead exactly.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS fallen (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          world TEXT NOT NULL,
          name TEXT NOT NULL,
          room TEXT NOT NULL,
          at INTEGER NOT NULL
        )
      `);

      // The rescued roll: the living pulled out of the cages, and who pulled
      // them. The hopeful mirror of `fallen`; same structured, name-direct shape.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS rescued (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          world TEXT NOT NULL,
          name TEXT NOT NULL,
          saved_by TEXT NOT NULL,
          at INTEGER NOT NULL
        )
      `);

      // Live presence: who is online, on which world, refreshed by each world's
      // heartbeat. Stale rows (a world that stopped reporting) are filtered out
      // by age on read, so a crashed world's players quietly disappear.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS presence (
          world TEXT NOT NULL,
          name TEXT NOT NULL,
          regard TEXT NOT NULL DEFAULT 'neutral',
          title TEXT NOT NULL DEFAULT '',
          at INTEGER NOT NULL,
          PRIMARY KEY (world, name)
        )
      `);

      // The world registry: who's on the Grid, and where to reach them.
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

  // Maintenance: the ledger's composition by kind (most numerous first). For a
  // keeper to see what the collective memory is actually made of.
  ledgerStats(): Array<{ kind: string; count: number }> {
    return this.ctx.storage.sql
      .exec<{ kind: string; count: number }>(
        "SELECT kind, COUNT(*) AS count FROM ledger GROUP BY kind ORDER BY count DESC",
      )
      .toArray();
  }

  // The memorial roll: record one of the fallen (best-effort on death), and read
  // the most recent fallen (newest first) so a world can list whom to remember.
  recordFallen(world: string, name: string, room: string, at: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO fallen (world, name, room, at) VALUES (?, ?, ?, ?)", world, name, room, at);
    // Keep the roll long but bounded; the dead are many on a dead network.
    sql.exec("DELETE FROM fallen WHERE id NOT IN (SELECT id FROM fallen ORDER BY id DESC LIMIT 500)");
  }

  recentFallen(limit: number): Fallen[] {
    return this.ctx.storage.sql
      .exec<Fallen>("SELECT world, name, room, at FROM fallen ORDER BY id DESC LIMIT ?", Math.max(1, Math.min(limit, 50)))
      .toArray();
  }

  // The rescued roll: record one of the saved (best-effort when cages are
  // freed), and read the most recent rescued (newest first).
  recordRescued(world: string, name: string, savedBy: string, at: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO rescued (world, name, saved_by, at) VALUES (?, ?, ?, ?)", world, name, savedBy, at);
    sql.exec("DELETE FROM rescued WHERE id NOT IN (SELECT id FROM rescued ORDER BY id DESC LIMIT 500)");
  }

  recentRescued(limit: number): Rescued[] {
    return this.ctx.storage.sql
      .exec<Rescued>("SELECT world, name, saved_by AS savedBy, at FROM rescued ORDER BY id DESC LIMIT ?", Math.max(1, Math.min(limit, 50)))
      .toArray();
  }

  // A world heartbeat: replace this world's whole roster (so disconnects clear).
  // Caller must authenticate as that world when GRID_WORLD_KEYS is configured.
  reportPresence(world: string, entries: Array<{ name: string; regard: string; title: string }>, at: number): void {
    this.assertRegisteredWorld(world);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM presence WHERE world = ?", world);
    for (const e of entries) {
      sql.exec("INSERT OR REPLACE INTO presence (world, name, regard, title, at) VALUES (?, ?, ?, ?, ?)", world, e.name, e.regard, e.title, at);
    }
  }

  private assertRegisteredWorld(world: string): void {
    const row = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM worlds WHERE id = ?", world)
      .one();
    if (!row.c) throw new Error(`unknown world: ${world}`);
  }

  private assertCharacterLease(name: string, world: string): void {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ lease_world: string; home_world: string }>(
        "SELECT lease_world, home_world FROM characters WHERE name = ?",
        name,
      )
      .toArray()[0];
    const lease = row?.lease_world?.trim() ?? "";
    if (!lease) {
      const home = row?.home_world?.trim() ?? "";
      if (home && home !== world) {
        throw new Error(`character ${name} home world is ${home}, cannot lease from ${world}`);
      }
      sql.exec("UPDATE characters SET lease_world = ? WHERE name = ?", world, name);
      return;
    }
    if (lease !== world) throw new Error(`character ${name} is leased to ${lease}, not ${world}`);
  }

  // Called by a world after local login auth succeeds; grants that world the commit lease.
  claimCharacterLease(name: string, world: string): void {
    this.assertRegisteredWorld(world);
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT OR IGNORE INTO characters (name, level, xp, gold, faction, morality, title, race, ashsworn, home_world, lease_world) VALUES (?, 1, 0, 20, 'none', 0, '', '', 0, ?, '')",
      name,
      world,
    );
    this.assertCharacterLease(name, world);
  }

  // The live roster across all worlds, dropping rows older than maxAgeMs (a world
  // that stopped sending heartbeats). Also opportunistically prunes the stale.
  presence(maxAgeMs: number): Presence[] {
    const sql = this.ctx.storage.sql;
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    sql.exec("DELETE FROM presence WHERE at < ?", cutoff);
    return sql.exec<Presence>("SELECT world, name, regard, title, at FROM presence ORDER BY world, name").toArray();
  }

  // Maintenance: delete ambient ledger noise only. Worlds may request a subset of
  // the ambient kinds, but arbitrary kinds are rejected at the hub.
  private static readonly PRUNABLE_LEDGER_KINDS = new Set(["ghost", "passage", "recall"]);

  pruneLedgerKinds(kinds: string[]): { removed: number } {
    const allowed = kinds.filter((k) => GridHub.PRUNABLE_LEDGER_KINDS.has(k));
    if (!allowed.length) return { removed: 0 };
    const sql = this.ctx.storage.sql;
    const before = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM ledger").one().c;
    const placeholders = allowed.map(() => "?").join(", ");
    sql.exec(`DELETE FROM ledger WHERE kind IN (${placeholders})`, ...allowed);
    const after = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM ledger").one().c;
    return { removed: before - after };
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
    // Collapse by world|node|text, NOT including `at`: one actor farming a
    // respawning mob (the stockade boss respawns every 60s) emits the same text
    // over and over with only `at` differing, and keying on `at` let all of them
    // survive as distinct rows -- a feed that is 75% "ollamabot slew the stockade
    // boss here" is the same signal-drowning problem the kind filter cured for
    // ghost drift. Keep the newest of each, with an (xN) count. Pull a generous
    // pool first so what fills the window is DISTINCT traces, not the tail of one
    // farming loop. (Surfaced by an Opus 4.8 review of the live feed.)
    const baseKey = (t: GridTrace) => `${t.world}|${t.node}|${t.text}`;
    const pool = clamp(lim * 8, lim, 200);
    const collapse = (rows: GridTrace[]): { t: GridTrace; count: number }[] => {
      const m = new Map<string, { t: GridTrace; count: number }>();
      for (const t of rows) {
        const e = m.get(baseKey(t)); // rows are id DESC, so the first seen is newest
        if (e) e.count++;
        else m.set(baseKey(t), { t, count: 1 });
      }
      return [...m.values()];
    };
    const foreign = collapse(
      sql.exec<GridTrace>("SELECT world, node, kind, text, at FROM ledger WHERE world != ? ORDER BY id DESC LIMIT ?", world, pool).toArray(),
    );
    const overall = collapse(
      sql.exec<GridTrace>("SELECT world, node, kind, text, at FROM ledger ORDER BY id DESC LIMIT ?", pool).toArray(),
    );
    const seen = new Set<string>();
    const picked: { t: GridTrace; count: number }[] = [];
    for (const e of foreign) {
      if (picked.length >= foreignQuota) break;
      seen.add(baseKey(e.t));
      picked.push(e);
    }
    for (const e of overall) {
      if (picked.length >= lim) break;
      if (seen.has(baseKey(e.t))) continue;
      seen.add(baseKey(e.t));
      picked.push(e);
    }
    return picked
      .map(({ t, count }) => (count > 1 ? { ...t, text: `${t.text} (x${count})` } : t))
      .sort((a, b) => b.at - a.at);
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

  // --- Canonical identity: the character that follows you --------------------
  loadCharacter(name: string, world: string): CharSheet {
    const row = this.ctx.storage.sql
      .exec<{
        level: number;
        xp: number;
        gold: number;
        faction: string;
        morality: number;
        title: string;
        race: string;
        ashsworn: number;
        home_world: string;
      }>("SELECT level, xp, gold, faction, morality, title, race, ashsworn, home_world FROM characters WHERE name = ?", name)
      .toArray()[0];
    if (row) return { ...row, ashsworn: !!row.ashsworn };
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO characters (name, level, xp, gold, faction, morality, title, race, ashsworn, home_world, lease_world) VALUES (?, 1, 0, 20, 'none', 0, '', '', 0, ?, '')",
      name,
      world,
    );
    return { level: 1, xp: 0, gold: 20, faction: "none", morality: 0, title: "", race: "", ashsworn: false };
  }

  // A world PROPOSES a character sheet; the hub VALIDATES it against bounds and
  // commits the result. This is the trust boundary: honest worlds pass, a cheaty
  // world's absurd deltas get clamped (no de-leveling, no implausible jumps, no
  // minting gold). Returns the committed (possibly clamped) sheet.
  commitCharacter(name: string, world: string, p: CharSheet): CharSheet {
    this.assertRegisteredWorld(world);
    const cur = this.loadCharacter(name, world);
    this.assertCharacterLease(name, world);
    const next: CharSheet = {
      level: clamp(Math.floor(p.level), cur.level, cur.level + MAX_LEVEL_DELTA), // never de-level; no big jumps
      xp: clamp(Math.floor(p.xp), cur.xp, cur.xp + MAX_XP_DELTA),
      gold: clamp(Math.floor(p.gold), 0, cur.gold + MAX_GOLD_DELTA), // bounded per commit
      faction: ["none", "front", "ally"].includes(p.faction) ? p.faction : cur.faction,
      morality: clamp(Math.floor(p.morality), -1000, 1000),
      title: String(p.title ?? "").replace(/[\r\n]/g, "").slice(0, 40),
      // race: an opaque label, sanitized but not validated against any list (any
      // world may define races); set once, then sticky (a character cannot reroll
      // their race across worlds).
      race: cur.race || String(p.race ?? "").replace(/[^a-z0-9_]/gi, "").toLowerCase().slice(0, 24),
      // ashsworn: the kapo brand is write-once true and never clears.
      ashsworn: cur.ashsworn || !!p.ashsworn,
    };
    this.ctx.storage.sql.exec(
      "UPDATE characters SET level = ?, xp = ?, gold = ?, faction = ?, morality = ?, title = ?, race = ?, ashsworn = ? WHERE name = ?",
      next.level,
      next.xp,
      next.gold,
      next.faction,
      next.morality,
      next.title,
      next.race,
      next.ashsworn ? 1 : 0,
      name,
    );
    return next;
  }

  // --- The world registry: travel destinations -------------------------------
  register(world: string, url: string): void {
    // An empty URL is an explicit withdrawal. This keeps temporary/test nodes
    // and intentionally retired worlds from becoming permanent dead routes.
    if (!url.trim()) {
      this.ctx.storage.sql.exec("DELETE FROM worlds WHERE id = ?", world);
      return;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO worlds (id, url, last_seen) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET url = excluded.url, last_seen = excluded.last_seen",
      world,
      url,
      Date.now(),
    );
    // Seed worlds from bootstrapping have last_seen=0; registering marks them live.
  }

  listWorlds(): WorldInfo[] {
    return this.ctx.storage.sql
      .exec<WorldInfo>("SELECT id, url, last_seen FROM worlds ORDER BY last_seen DESC, id ASC")
      .toArray();
  }
}
