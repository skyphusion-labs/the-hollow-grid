import type { Env } from "./types";
import type { GridHub } from "./gridhub";
import { verifyRpcWorldAuth } from "./rpc-auth";
import { verifyRpcBearer } from "./world-auth";

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

  let body: { method?: string; params?: unknown[] };
  try {
    body = await req.json();
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 400 });
  }
}

async function dispatch(hub: HubStub, method: string, params: unknown[], req: Request): Promise<unknown> {
  switch (method) {
    case "record":
      return hub.record(String(params[0]), String(params[1]), String(params[2]), String(params[3]), Number(params[4]));
    case "recent":
      return hub.recent(Number(params[0]));
    case "recentAcross":
      return hub.recentAcross(String(params[0]), Number(params[1]));
    case "tide":
      return hub.tide();
    case "shiftTide":
      return hub.shiftTide(Number(params[0]));
    case "gridcast":
      return hub.gridcast(String(params[0]), String(params[1]), String(params[2]));
    case "castsSince":
      return hub.castsSince(Number(params[0]), Number(params[1]));
    case "loadCharacter": {
      const world = String(params[1] ?? req.headers.get("X-Grid-World") ?? "");
      if (!world) throw new Error("world required for loadCharacter");
      return hub.loadCharacter(String(params[0]), world);
    }
    case "commitCharacter":
      return hub.commitCharacter(String(params[0]), String(params[1]), params[2] as never);
    case "claimCharacterLease":
      return hub.claimCharacterLease(String(params[0]), String(params[1]));
    case "releaseCharacterLease":
      return hub.releaseCharacterLease(String(params[0]), String(params[1]));
    case "register":
      return hub.register(String(params[0]), String(params[1]));
    case "listWorlds":
      return hub.listWorlds();
    case "ledgerStats":
      return hub.ledgerStats();
    case "pruneLedgerKinds":
      return hub.pruneLedgerKinds(params[0] as string[]);
    case "recordFallen":
      return hub.recordFallen(String(params[0]), String(params[1]), String(params[2]), Number(params[3]));
    case "recentFallen":
      return hub.recentFallen(Number(params[0]));
    case "recordRescued":
      return hub.recordRescued(String(params[0]), String(params[1]), String(params[2]), Number(params[3]));
    case "recentRescued":
      return hub.recentRescued(Number(params[0]));
    case "reportPresence":
      return hub.reportPresence(String(params[0]), params[1] as never, Number(params[2]));
    case "presence":
      return hub.presence(Number(params[0]));
    default:
      throw new Error(`unknown method: ${method}`);
  }
}
