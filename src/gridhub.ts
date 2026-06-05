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
}
