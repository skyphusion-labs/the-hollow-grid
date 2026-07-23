import type { Env } from "./types";
import { playPage } from "./webclient";
import { MAP_SVG } from "./map-svg";
import { assertAllowedWsOrigin } from "./ws-origin";

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

/** Cache deep-health probes to limit DO wake amplification (K3 wave 15/16). */
const DEEP_HEALTH_CACHE_MS = 30_000;
let gridHubHealthCache: { ok: boolean; latency_ms: number; at: number } | null = null;
let deepHealthCache: { body: Record<string, unknown>; status: number; at: number } | null = null;

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
  const cached = deepHealthCache;
  if (cached && Date.now() - cached.at < DEEP_HEALTH_CACHE_MS) {
    return json(cached.body, { status: cached.status });
  }

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
    } catch {
      checks.world = { ok: false, latency_ms: Date.now() - t0, critical: true, error: "health check failed" };
    }
  }

  // Grid Hub: a cheap tide() read confirms the federation backend is reachable.
  // Non-critical -- a world runs standalone on hub failure, so a hub outage is
  // reported but does not 503 the probe. Skipped when GRID is unbound (a
  // standalone deploy with no federation).
  if (env.GRID) {
    const cached = gridHubHealthCache;
    if (cached && Date.now() - cached.at < DEEP_HEALTH_CACHE_MS) {
      checks.grid_hub = { ok: cached.ok, latency_ms: cached.latency_ms, critical: false, ...(cached.ok ? {} : { error: "health check failed" }) };
    } else {
      const t0 = Date.now();
      try {
        await env.GRID.tide();
        const latency_ms = Date.now() - t0;
        gridHubHealthCache = { ok: true, latency_ms, at: Date.now() };
        checks.grid_hub = { ok: true, latency_ms, critical: false };
      } catch {
        const latency_ms = Date.now() - t0;
        gridHubHealthCache = { ok: false, latency_ms, at: Date.now() };
        checks.grid_hub = { ok: false, latency_ms, critical: false, error: "health check failed" };
      }
    }
  }

  // A failed non-critical check is degraded, not down: only critical failures
  // flip the overall status to 503.
  const allOk = Object.values(checks).every((c) => c.ok || !c.critical);
  const body = { ok: allOk, ts: Date.now(), world: env.WORLD_NAME ?? "The Hollow Grid", checks };
  const status = allOk ? 200 : 503;
  deepHealthCache = { body, status, at: Date.now() };
  return json(body, { status });
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

    // The world map (generated from rooms.ts by `npm run map`, embedded at build
    // time). Served live so the site can hot-link a self-updating map.
    if (url.pathname === "/map.svg") {
      return new Response(MAP_SVG, {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    if (url.pathname === "/ws") {
      try {
        assertAllowedWsOrigin(request);
      } catch {
        return new Response("Forbidden", { status: 403 });
      }
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
