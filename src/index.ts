import type { Env } from "./types";
import { playPage } from "./webclient";

// The Durable Object class must be exported from the Worker entry module.
// (The Grid Hub is no longer here -- it lives in its own backend Worker,
// grid-hub/, reached through the GRID service binding. See docs/federation.md.)
export { World } from "./world";

// ---------- Health checks ----------
//
// GET /health       Liveness probe: no binding access, sub-millisecond, always
//                   200. Use for high-frequency uptime polling (Kuma at 60s).
// GET /health/deep  Exercises the dependencies once each: the World Durable
//                   Object (and its SQLite) and the Grid Hub binding. Each
//                   check is timed independently and the body carries per-check
//                   ok/latency, so a partial outage is visible. Returns 503 if
//                   a CRITICAL check fails -- only the World DO is critical. The
//                   hub is reported but non-critical: federation never blocks
//                   play (a world runs standalone on hub failure, see
//                   docs/federation.md), so a hub outage degrades cross-world
//                   features without flipping the world red. Poll less often
//                   than /health (50-200ms typical).

interface HealthCheckResult {
  ok: boolean;
  latency_ms: number;
  critical: boolean;
  error?: string;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

async function handleHealthDeep(env: Env): Promise<Response> {
  const checks: Record<string, HealthCheckResult> = {};

  // World DO: the single shared instance must be awake and its SQLite must
  // answer a trivial query. The DO owns all local game state, so this is the
  // critical check -- if it fails the world is down.
  {
    const t0 = Date.now();
    try {
      const stub = env.WORLD.getByName("world");
      const res = await stub.fetch("https://world/health");
      if (!res.ok) throw new Error(`world DO returned ${res.status}`);
      checks.world = { ok: true, latency_ms: Date.now() - t0, critical: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.world = { ok: false, latency_ms: Date.now() - t0, critical: true, error: m };
    }
  }

  // Grid Hub: a cheap tide() read confirms the federation backend is reachable.
  // Non-critical -- a world runs standalone on hub failure, so a hub outage is
  // reported but does not 503 the probe. Skipped when GRID is unbound (a
  // standalone deploy with no federation).
  if (env.GRID) {
    const t0 = Date.now();
    try {
      await env.GRID.tide();
      checks.grid_hub = { ok: true, latency_ms: Date.now() - t0, critical: false };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.grid_hub = { ok: false, latency_ms: Date.now() - t0, critical: false, error: m };
    }
  }

  // A failed non-critical check is degraded, not down: only critical failures
  // flip the overall status to 503.
  const allOk = Object.values(checks).every((c) => c.ok || !c.critical);
  return json(
    { ok: allOk, ts: Date.now(), world: env.WORLD_NAME ?? "The Hollow Grid", checks },
    { status: allOk ? 200 : 503 },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Liveness: no binding access. Safe for frequent polling.
    if (url.pathname === "/health") {
      return json({ ok: true, ts: Date.now(), world: env.WORLD_NAME ?? "The Hollow Grid" });
    }

    // Deep check: exercises the World DO and the Grid Hub binding.
    if (url.pathname === "/health/deep" && request.method === "GET") {
      return handleHealthDeep(env);
    }

    if (url.pathname === "/ws") {
      // One shared world instance. Everyone routes to the same DO.
      const stub = env.WORLD.getByName("world");
      return stub.fetch(request);
    }

    // Anything else: serve the browser play client (it connects back to /ws on
    // this same host, so each world serves its own playable terminal).
    return new Response(playPage(env.WORLD_NAME ?? "The Hollow Grid"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
