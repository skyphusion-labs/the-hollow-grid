import type { Env } from "./types";
import type { GridHub } from "./gridhub";
import { verifyRpcWorldAuth } from "./rpc-auth";
import { verifyRpcBearer } from "./world-auth";
import {
  clampRpcInt,
  clampRpcString,
  LIMIT_CHARACTER_NAME,
  LIMIT_LEDGER_KIND,
  LIMIT_WORLD_ID,
  MAX_RPC_BODY_BYTES,
  requireRpcObject,
  requireRpcString,
} from "./rpc-limits";

type HubStub = DurableObjectStub<GridHub>;

// HTTP JSON-RPC ingress for external world nodes (fleet Go worlds, etc.) that
// cannot reach the hub over a Cloudflare service binding. Auth is a shared
// bearer token (GRID_RPC_TOKEN); when unset, /rpc is disabled.
export async function handleRPC(req: Request, env: Env): Promise<Response> {
  if (!env.GRID_RPC_TOKEN) {
    return Response.json({ ok: false, error: "rpc disabled (GRID_RPC_TOKEN unset)" }, { status: 503 });
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (!verifyRpcBearer(auth, env.GRID_RPC_TOKEN)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const cl = req.headers.get("Content-Length");
  if (cl !== null && Number(cl) > MAX_RPC_BODY_BYTES) {
    return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const raw = await req.text();
  if (raw.length > MAX_RPC_BODY_BYTES) {
    return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  let body: { method?: string; params?: unknown[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const method = body.method?.trim();
  if (!method) {
    return Response.json({ ok: false, error: "method required" }, { status: 400 });
  }
  const params = Array.isArray(body.params) ? body.params : [];

  const authErr = verifyRpcWorldAuth(env, method, params, {
    world: req.headers.get("X-Grid-World") ?? "",
    worldKey: req.headers.get("X-Grid-World-Key") ?? undefined,
  });
  if (authErr) return authErr;

  const hub = env.GRIDHUB.getByName("grid");
  try {
    const result = await dispatch(hub, method, params, req);
    return Response.json({ ok: true, result });
  } catch {
    return Response.json({ ok: false, error: "request failed" }, { status: 400 });
  }
}

async function dispatch(hub: HubStub, method: string, params: unknown[], req: Request): Promise<unknown> {
  const headerWorld = req.headers.get("X-Grid-World") ?? "";
  switch (method) {
    case "record":
      return hub.record(
        clampRpcString(params[0], LIMIT_WORLD_ID),
        clampRpcString(params[1], 128),
        clampRpcString(params[2], LIMIT_LEDGER_KIND),
        clampRpcString(params[3], 500),
        clampRpcInt(params[4], 0, Number.MAX_SAFE_INTEGER, Date.now()),
      );
    case "recent":
      return hub.recent(clampRpcInt(params[0], 1, 200, 20));
    case "recentAcross":
      return hub.recentAcross(clampRpcString(params[0], LIMIT_WORLD_ID), clampRpcInt(params[1], 1, 50, 20));
    case "tide":
      return hub.tide();
    case "shiftTide":
      return hub.shiftTide(clampRpcInt(params[0], -100, 100, 0), headerWorld || undefined);
    case "gridcast":
      return hub.gridcast(
        clampRpcString(params[0], LIMIT_WORLD_ID),
        clampRpcString(params[1], LIMIT_CHARACTER_NAME),
        clampRpcString(params[2], 500),
      );
    case "castsSince":
      return hub.castsSince(clampRpcInt(params[0], 0, Number.MAX_SAFE_INTEGER, 0), clampRpcInt(params[1], 1, 50, 20));
    case "loadCharacter": {
      const world = clampRpcString(params[1] ?? headerWorld, LIMIT_WORLD_ID);
      if (!world) throw new Error("world required for loadCharacter");
      return hub.loadCharacter(requireRpcString(params[0], LIMIT_CHARACTER_NAME, "character name"), world);
    }
    case "commitCharacter":
      return hub.commitCharacter(
        requireRpcString(params[0], LIMIT_CHARACTER_NAME, "character name"),
        clampRpcString(params[1], LIMIT_WORLD_ID),
        requireRpcObject(params[2], "character sheet") as never,
      );
    case "claimCharacterLease":
      return hub.claimCharacterLease(
        requireRpcString(params[0], LIMIT_CHARACTER_NAME, "character name"),
        clampRpcString(params[1], LIMIT_WORLD_ID),
      );
    case "releaseCharacterLease":
      return hub.releaseCharacterLease(
        requireRpcString(params[0], LIMIT_CHARACTER_NAME, "character name"),
        clampRpcString(params[1], LIMIT_WORLD_ID),
      );
    case "register":
      return hub.register(clampRpcString(params[0], LIMIT_WORLD_ID), clampRpcString(params[1], 512));
    case "listWorlds":
      return hub.listWorlds();
    case "ledgerStats":
      return hub.ledgerStats();
    case "pruneLedgerKinds":
      return hub.pruneLedgerKinds(params[0] as string[]);
    case "recordFallen":
      return hub.recordFallen(
        clampRpcString(params[0], LIMIT_WORLD_ID),
        requireRpcString(params[1], LIMIT_CHARACTER_NAME, "character name"),
        clampRpcString(params[2], 64),
        clampRpcInt(params[3], 0, Number.MAX_SAFE_INTEGER, Date.now()),
      );
    case "recentFallen":
      return hub.recentFallen(clampRpcInt(params[0], 1, 100, 20));
    case "recordRescued":
      return hub.recordRescued(
        clampRpcString(params[0], LIMIT_WORLD_ID),
        requireRpcString(params[1], LIMIT_CHARACTER_NAME, "character name"),
        requireRpcString(params[2], LIMIT_CHARACTER_NAME, "character name"),
        clampRpcInt(params[3], 0, Number.MAX_SAFE_INTEGER, Date.now()),
      );
    case "recentRescued":
      return hub.recentRescued(clampRpcInt(params[0], 1, 100, 20));
    case "reportPresence":
      return hub.reportPresence(
        clampRpcString(params[0], LIMIT_WORLD_ID),
        Array.isArray(params[1]) ? (params[1] as never) : [],
        clampRpcInt(params[2], 0, Number.MAX_SAFE_INTEGER, Date.now()),
      );
    case "presence":
      return hub.presence(clampRpcInt(params[0], 60_000, 86_400_000, 300_000));
    default:
      throw new Error(`unknown method: ${method}`);
  }
}
