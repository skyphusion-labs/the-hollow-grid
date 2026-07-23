import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import type { GridTrace, GridCast, CharSheet, WorldInfo, Fallen, Rescued, Presence } from "../../shared/grid";
import { assertRegisterUrl } from "./register-url";
import { sanitizePlayerText } from "../../shared/sanitize-player-text";
import { worldAuthRequired } from "./world-auth";
import { finiteInt } from "./numeric";
import { leaseExpiryCutoff } from "./character-lease";
import { nextCommitWindow, commitGainAllowed } from "./commit-rate-limit";
import { nextTideShift } from "./tide-rate-limit";
import { effectivePresenceMaxAge } from "./presence-age";
import { clampRpcString, LIMIT_CHARACTER_NAME, LIMIT_LEDGER_KIND, LIMIT_WORLD_ID, requireRpcString } from "./rpc-limits";

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

const MAX_TIDE_SHIFT = 10;
const MAX_PRESENCE_ENTRIES = 256;

// Per-commit caps on progression deltas (K3 #86 + wave 16: plausible gameplay gains only).
const MAX_GOLD_DELTA = 500;
const MAX_XP_DELTA = 500;
const MAX_LEVEL_DELTA = 1;
const MAX_MORALITY_DELTA = 50;

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
        "lease_at INTEGER NOT NULL DEFAULT 0",
        "commit_window_at INTEGER NOT NULL DEFAULT 0",
        "commit_window_count INTEGER NOT NULL DEFAULT 0",
        "commit_window_gold_gain INTEGER NOT NULL DEFAULT 0",
        "commit_window_xp_gain INTEGER NOT NULL DEFAULT 0",
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
      sql.exec(`
        CREATE TABLE IF NOT EXISTS tide_rate (
          world TEXT PRIMARY KEY,
          window_at INTEGER NOT NULL DEFAULT 0,
          window_pos INTEGER NOT NULL DEFAULT 0,
          window_neg INTEGER NOT NULL DEFAULT 0
        )
      `);
      for (const col of ["window_pos INTEGER NOT NULL DEFAULT 0", "window_neg INTEGER NOT NULL DEFAULT 0"]) {
        try {
          sql.exec(`ALTER TABLE tide_rate ADD COLUMN ${col}`);
        } catch {
          // column already exists
        }
      }
      const worldCount = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM worlds").one().c;
      if (worldCount === 0) {
        for (const w of SEED_WORLDS) {
          sql.exec("INSERT INTO worlds (id, url, last_seen) VALUES (?, ?, 0)", w.id, w.url);
        }
      }

      // Legacy lease columns: copy active lease into home when home was never set.
      sql.exec("UPDATE characters SET home_world = lease_world WHERE home_world = '' AND lease_world != ''");
    });
  }

  // A world reports a notable event into the shared Grid memory. RPC-callable.
  record(world: string, node: string, kind: string, text: string, _at: number): void {
    world = clampRpcString(world, LIMIT_WORLD_ID);
    this.assertRegisteredWorld(world);
    const sql = this.ctx.storage.sql;
    const safeNode = sanitizePlayerText(node, 80);
    const safeKind = sanitizePlayerText(kind, LIMIT_LEDGER_KIND);
    const safeText = sanitizePlayerText(text, 500);
    sql.exec("INSERT INTO ledger (world, node, kind, text, at) VALUES (?, ?, ?, ?, ?)", world, safeNode, safeKind, safeText, Date.now());
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
  recordFallen(world: string, name: string, room: string, _at: number): void {
    world = clampRpcString(world, LIMIT_WORLD_ID);
    this.assertRegisteredWorld(world);
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO fallen (world, name, room, at) VALUES (?, ?, ?, ?)",
      world,
      sanitizePlayerText(name, 32),
      sanitizePlayerText(room, 80),
      Date.now(),
    );
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
  recordRescued(world: string, name: string, savedBy: string, _at: number): void {
    world = clampRpcString(world, LIMIT_WORLD_ID);
    this.assertRegisteredWorld(world);
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO rescued (world, name, saved_by, at) VALUES (?, ?, ?, ?)",
      world,
      sanitizePlayerText(name, 32),
      sanitizePlayerText(savedBy, 32),
      Date.now(),
    );
    sql.exec("DELETE FROM rescued WHERE id NOT IN (SELECT id FROM rescued ORDER BY id DESC LIMIT 500)");
  }

  recentRescued(limit: number): Rescued[] {
    return this.ctx.storage.sql
      .exec<Rescued>("SELECT world, name, saved_by AS savedBy, at FROM rescued ORDER BY id DESC LIMIT ?", Math.max(1, Math.min(limit, 50)))
      .toArray();
  }

  // A world heartbeat: replace this world's whole roster (so disconnects clear).
  // Caller must authenticate as that world when GRID_WORLD_KEYS is configured.
  reportPresence(world: string, entries: Array<{ name: string; regard: string; title: string }>, _at: number): void {
    this.assertRegisteredWorld(world);
    if (entries.length > MAX_PRESENCE_ENTRIES) {
      throw new Error(`presence entries capped at ${MAX_PRESENCE_ENTRIES}`);
    }
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM presence WHERE world = ?", world);
    for (const e of entries) {
      const name = sanitizePlayerText(e.name, 32);
      const leased = sql
        .exec<{ lease_world: string }>("SELECT lease_world FROM characters WHERE name = ?", name)
        .toArray()[0];
      if (!leased) continue;
      const lw = leased.lease_world?.trim() ?? "";
      if (lw !== world && lw !== "") continue;
      sql.exec(
        "INSERT OR REPLACE INTO presence (world, name, regard, title, at) VALUES (?, ?, ?, ?, ?)",
        world,
        name,
        sanitizePlayerText(e.regard, 24),
        sanitizePlayerText(e.title, 40),
        Date.now(),
      );
    }
  }

  private assertRegisteredWorld(world: string): void {
    const row = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM worlds WHERE id = ?", world)
      .one();
    if (!row.c) throw new Error(`unknown world: ${world}`);
  }

  private expireStaleLeases(now = Date.now()): void {
    const cutoff = leaseExpiryCutoff(now);
    const sql = this.ctx.storage.sql;
    sql.exec(
      "UPDATE characters SET lease_world = '', lease_at = 0 WHERE lease_world != '' AND lease_at > 0 AND lease_at < ?",
      cutoff,
    );
    // Pre-wave-13 rows: active lease with no timestamp (crash lockout recovery).
    sql.exec(
      "UPDATE characters SET lease_world = '', lease_at = 0 WHERE lease_world != '' AND lease_at = 0",
    );
  }

  private assertCharacterLease(name: string, world: string): void {
    this.expireStaleLeases();
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ lease_world: string; home_world: string }>(
        "SELECT lease_world, home_world FROM characters WHERE name = ?",
        name,
      )
      .toArray()[0];
    if (!row) {
      throw new Error(`character ${name} not found; claimCharacterLease first`);
    }
    const lease = row.lease_world?.trim() ?? "";
    const home = row.home_world?.trim() ?? "";
    if (lease === world) return;
    if (lease) {
      throw new Error(`character ${name} is leased to ${lease}, not ${world}`);
    }
    if (home && home !== world) {
      throw new Error(`character ${name} home world is ${home}, cannot lease from ${world}`);
    }
    sql.exec("UPDATE characters SET lease_world = ?, lease_at = ? WHERE name = ?", world, Date.now(), name);
  }

  // Called by a world after local login auth succeeds; grants that world the commit lease.
  // home_world pins at authenticated claim so a lease-expiry race cannot let another
  // world commit first and steal the character (K3 wave 15).
  claimCharacterLease(name: string, world: string): void {
    name = requireRpcString(name, LIMIT_CHARACTER_NAME, "character name");
    world = clampRpcString(world, LIMIT_WORLD_ID);
    this.assertRegisteredWorld(world);
    this.expireStaleLeases();
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ lease_world: string; home_world: string }>(
        "SELECT lease_world, home_world FROM characters WHERE name = ?",
        name,
      )
      .toArray()[0];
    const now = Date.now();
    if (!row) {
      sql.exec(
        "INSERT INTO characters (name, level, xp, gold, faction, morality, title, race, ashsworn, home_world, lease_world, lease_at) VALUES (?, 1, 0, 20, 'none', 0, '', '', 0, ?, ?, ?)",
        name,
        world,
        world,
        now,
      );
      return;
    }
    const home = row.home_world?.trim() ?? "";
    const lease = row.lease_world?.trim() ?? "";
    if (home && home !== world) {
      throw new Error(`character ${name} home world is ${home}, cannot claim from ${world}`);
    }
    if (lease && lease !== world) {
      throw new Error(`character ${name} is leased to ${lease}, not ${world}`);
    }
    sql.exec(
      "UPDATE characters SET lease_world = ?, lease_at = ?, home_world = CASE WHEN home_world = '' THEN ? ELSE home_world END WHERE name = ?",
      world,
      now,
      world,
      name,
    );
  }

  // Drop this world's commit lease on logout/disconnect so another world can claim.
  releaseCharacterLease(name: string, world: string): void {
    name = requireRpcString(name, LIMIT_CHARACTER_NAME, "character name");
    this.assertRegisteredWorld(world);
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ lease_world: string }>("SELECT lease_world FROM characters WHERE name = ?", name)
      .toArray()[0];
    if (!row) return;
    const lease = row.lease_world?.trim() ?? "";
    if (lease && lease !== world) {
      throw new Error(`character ${name} is leased to ${lease}, not ${world}`);
    }
    sql.exec(
      "UPDATE characters SET lease_world = '', lease_at = 0 WHERE name = ? AND lease_world = ?",
      name,
      world,
    );
  }

  // The live roster across all worlds, dropping rows older than maxAgeMs (a world
  // that stopped sending heartbeats). Also opportunistically prunes the stale.
  presence(maxAgeMs: number): Presence[] {
    const sql = this.ctx.storage.sql;
    const cutoff = Date.now() - effectivePresenceMaxAge(maxAgeMs);
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

  shiftTide(delta: number, world?: string): number {
    const sql = this.ctx.storage.sql;
    if (world) {
      world = clampRpcString(world, LIMIT_WORLD_ID);
      this.assertRegisteredWorld(world);
    }
    if (!Number.isFinite(delta)) return this.tide();
    let bounded = clamp(Math.floor(delta), -MAX_TIDE_SHIFT, MAX_TIDE_SHIFT);
    if (world && bounded !== 0 && worldAuthRequired(this.env)) {
      const now = Date.now();
      const row = sql
        .exec<{ window_at: number; window_pos: number; window_neg: number }>(
          "SELECT window_at, window_pos, window_neg FROM tide_rate WHERE world = ?",
          world,
        )
        .toArray()[0];
      const rate = nextTideShift(row?.window_at ?? 0, row?.window_pos ?? 0, row?.window_neg ?? 0, bounded, now);
      if (!rate.ok) throw new Error(`tide shift rate limit exceeded for ${world}`);
      sql.exec(
        "INSERT OR REPLACE INTO tide_rate (world, window_at, window_pos, window_neg) VALUES (?, ?, ?, ?)",
        world,
        rate.windowAt,
        rate.windowPos,
        rate.windowNeg,
      );
      bounded = rate.applied;
    }
    const next = Math.max(-100, Math.min(100, this.tide() + bounded));
    sql.exec("UPDATE meta SET v = ? WHERE k = 'tide'", next);
    return next;
  }

  // --- Cross-world chat ------------------------------------------------------
  gridcast(world: string, sender: string, text: string): void {
    world = clampRpcString(world, LIMIT_WORLD_ID);
    this.assertRegisteredWorld(world);
    const safeSender = sanitizePlayerText(sender, 32);
    this.assertCastSender(safeSender, world);
    const sql = this.ctx.storage.sql;
    const safeText = sanitizePlayerText(text, 500);
    sql.exec("INSERT INTO casts (world, sender, text, at) VALUES (?, ?, ?, ?)", world, safeSender, safeText, Date.now());
    sql.exec("DELETE FROM casts WHERE id NOT IN (SELECT id FROM casts ORDER BY id DESC LIMIT 200)");
  }

  private assertCastSender(sender: string, world: string): void {
    if (!sender) throw new Error("gridcast sender required");
    this.expireStaleLeases();
    const row = this.ctx.storage.sql
      .exec<{ lease_world: string }>("SELECT lease_world FROM characters WHERE name = ?", sender)
      .toArray()[0];
    if (!row || row.lease_world !== world) {
      throw new Error(`sender ${sender} is not leased to ${world}`);
    }
  }

  // Worlds poll this each tick for casts newer than the last one they relayed.
  castsSince(sinceId: number, limit: number): GridCast[] {
    return this.ctx.storage.sql
      .exec<GridCast>("SELECT id, world, sender, text FROM casts WHERE id > ? ORDER BY id ASC LIMIT ?", sinceId, Math.max(1, Math.min(limit, 50)))
      .toArray();
  }

  // --- Canonical identity: the character that follows you --------------------
  loadCharacter(name: string, _world: string): CharSheet {
    name = requireRpcString(name, LIMIT_CHARACTER_NAME, "character name");
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
      }>("SELECT level, xp, gold, faction, morality, title, race, ashsworn FROM characters WHERE name = ?", name)
      .toArray()[0];
    if (row) return { ...row, ashsworn: !!row.ashsworn };
    // Read-only: row creation belongs to claimCharacterLease (authenticated).
    return { level: 1, xp: 0, gold: 20, faction: "none", morality: 0, title: "", race: "", ashsworn: false };
  }

  // A world PROPOSES a character sheet; the hub VALIDATES it against bounds and
  // commits the result. This is the trust boundary: honest worlds pass, a cheaty
  // world's absurd deltas get clamped (no de-leveling, no implausible jumps, no
  // minting gold). Returns the committed (possibly clamped) sheet.
  commitCharacter(name: string, world: string, p: CharSheet): CharSheet {
    name = requireRpcString(name, LIMIT_CHARACTER_NAME, "character name");
    this.assertRegisteredWorld(world);
    this.assertCharacterLease(name, world);
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const meta = sql
      .exec<{
        home_world: string;
        commit_window_at: number;
        commit_window_count: number;
        commit_window_gold_gain: number;
        commit_window_xp_gain: number;
      }>(
        "SELECT home_world, commit_window_at, commit_window_count, commit_window_gold_gain, commit_window_xp_gain FROM characters WHERE name = ?",
        name,
      )
      .toArray()[0];
    const home = meta?.home_world?.trim() ?? "";
    if (home && home !== world) {
      throw new Error(`character ${name} home world is ${home}, cannot commit from ${world}`);
    }
    if (!home) {
      sql.exec("UPDATE characters SET home_world = ? WHERE name = ? AND home_world = ''", world, name);
    }
    const rate = nextCommitWindow(meta?.commit_window_at ?? 0, meta?.commit_window_count ?? 0, now);
    if (!rate.ok) throw new Error(`character ${name} commit rate limit exceeded`);
    const cur = this.loadCharacter(name, world);
    const proposedGold = clamp(finiteInt(p.gold, cur.gold), cur.gold, cur.gold + MAX_GOLD_DELTA);
    const proposedXp = clamp(finiteInt(p.xp, cur.xp), cur.xp, cur.xp + MAX_XP_DELTA);
    const gain = commitGainAllowed(
      meta?.commit_window_at ?? 0,
      meta?.commit_window_gold_gain ?? 0,
      meta?.commit_window_xp_gain ?? 0,
      proposedGold - cur.gold,
      proposedXp - cur.xp,
      now,
    );
    if (!gain.ok) throw new Error(`character ${name} commit gain limit exceeded`);
    sql.exec(
      "UPDATE characters SET lease_at = ?, commit_window_at = ?, commit_window_count = ?, commit_window_gold_gain = ?, commit_window_xp_gain = ? WHERE name = ? AND lease_world = ?",
      now,
      gain.windowAt,
      rate.windowCount,
      gain.windowGoldGain,
      gain.windowXpGain,
      name,
      world,
    );
    const next: CharSheet = {
      level: clamp(finiteInt(p.level, cur.level), cur.level, cur.level + MAX_LEVEL_DELTA), // never de-level; no big jumps
      xp: proposedXp,
      gold: proposedGold, // never decreases; bounded per commit and per window
      faction: ["none", "front", "ally"].includes(p.faction) ? p.faction : cur.faction,
      morality: clamp(
        clamp(finiteInt(p.morality, cur.morality), cur.morality - MAX_MORALITY_DELTA, cur.morality + MAX_MORALITY_DELTA),
        -1000,
        1000,
      ),
      title: sanitizePlayerText(String(p.title ?? ""), 40),
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
    world = clampRpcString(world, LIMIT_WORLD_ID);
    // An empty URL is an explicit withdrawal. This keeps temporary/test nodes
    // and intentionally retired worlds from becoming permanent dead routes.
    if (!url.trim()) {
      this.ctx.storage.sql.exec("DELETE FROM worlds WHERE id = ?", world);
      return;
    }
    assertRegisterUrl(url);
    const existing = this.ctx.storage.sql
      .exec<{ last_seen: number }>("SELECT last_seen FROM worlds WHERE id = ?", world)
      .toArray()[0];
    if (existing && existing.last_seen > 0 && !worldAuthRequired(this.env)) {
      throw new Error("register URL update requires GRID_WORLD_KEYS");
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
