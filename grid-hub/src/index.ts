import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";
import type { GridHubApi, GridTrace, GridCast, CharSheet, WorldInfo, Fallen, Rescued, Presence } from "../../shared/grid";

// The Durable Object class must be exported from the Worker entry module.
export { GridHub } from "./gridhub";

// The federation backend's public RPC surface. Worlds bind THIS Worker as a
// service (entrypoint "GridHubService") and call these methods directly over
// the binding; each one forwards to the single global GridHub Durable Object.
//
// This thin entrypoint is the seam that splits the backend out: the DO holds the
// state, and this WorkerEntrypoint makes it reachable from OTHER deployments. A
// world calling `env.GRID.record(...)` looks identical to the old in-Worker DO
// RPC, but the call now crosses a deployment boundary. (See docs/federation.md.)
export class GridHubService extends WorkerEntrypoint<Env> implements GridHubApi {
  private hub() {
    return this.env.GRIDHUB.getByName("grid");
  }

  async record(world: string, node: string, kind: string, text: string, at: number): Promise<void> {
    await this.hub().record(world, node, kind, text, at);
  }
  recent(limit: number): Promise<GridTrace[]> {
    return this.hub().recent(limit);
  }
  recentAcross(world: string, limit: number): Promise<GridTrace[]> {
    return this.hub().recentAcross(world, limit);
  }

  tide(): Promise<number> {
    return this.hub().tide();
  }
  shiftTide(delta: number): Promise<number> {
    return this.hub().shiftTide(delta);
  }

  async gridcast(world: string, sender: string, text: string): Promise<void> {
    await this.hub().gridcast(world, sender, text);
  }
  castsSince(sinceId: number, limit: number): Promise<GridCast[]> {
    return this.hub().castsSince(sinceId, limit);
  }

  loadCharacter(name: string): Promise<CharSheet> {
    return this.hub().loadCharacter(name);
  }
  commitCharacter(name: string, p: CharSheet): Promise<CharSheet> {
    return this.hub().commitCharacter(name, p);
  }

  async register(world: string, url: string): Promise<void> {
    await this.hub().register(world, url);
  }
  listWorlds(): Promise<WorldInfo[]> {
    return this.hub().listWorlds();
  }

  ledgerStats(): Promise<Array<{ kind: string; count: number }>> {
    return this.hub().ledgerStats();
  }
  pruneLedgerKinds(kinds: string[]): Promise<{ removed: number }> {
    return this.hub().pruneLedgerKinds(kinds);
  }

  async recordFallen(world: string, name: string, room: string, at: number): Promise<void> {
    await this.hub().recordFallen(world, name, room, at);
  }
  recentFallen(limit: number): Promise<Fallen[]> {
    return this.hub().recentFallen(limit);
  }

  async recordRescued(world: string, name: string, savedBy: string, at: number): Promise<void> {
    await this.hub().recordRescued(world, name, savedBy, at);
  }
  recentRescued(limit: number): Promise<Rescued[]> {
    return this.hub().recentRescued(limit);
  }

  async reportPresence(world: string, entries: Array<{ name: string; regard: string; title: string }>, at: number): Promise<void> {
    await this.hub().reportPresence(world, entries, at);
  }
  presence(maxAgeMs: number): Promise<Presence[]> {
    return this.hub().presence(maxAgeMs);
  }
}

import { handleRPC } from "./rpc";

// Worlds on Cloudflare reach the hub via the GRID service binding. External nodes
// (fleet Go worlds) use POST /rpc with GRID_RPC_TOKEN when configured.
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/rpc") {
      return handleRPC(req, env);
    }
    if (req.method === "GET" && path === "/health") {
      return Response.json({ ok: true, service: "grid-hub" });
    }
    return new Response(
      "THE GRID HUB: the federation backend for The Hollow Grid.\n" +
        "Worlds on Cloudflare bind GRID (RPC). External nodes POST /rpc with GRID_RPC_TOKEN.\n",
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
