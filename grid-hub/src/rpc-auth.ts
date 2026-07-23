import type { Env } from "./types";
import { assertWorldAuth, worldAuthRequired } from "./world-auth";

/** RPC methods that mutate federation state and require world attribution. */
export const WORLD_AUTH_METHODS = new Set([
  "commitCharacter",
  "reportPresence",
  "register",
  "claimCharacterLease",
  "record",
  "shiftTide",
  "gridcast",
  "recordFallen",
  "recordRescued",
  "pruneLedgerKinds",
]);

/** Methods whose world comes from X-Grid-World when not in params. */
const HEADER_WORLD_METHODS = new Set(["shiftTide", "pruneLedgerKinds"]);

export function worldFromRpcParams(method: string, params: unknown[], headerWorld: string): string {
  switch (method) {
    case "commitCharacter":
      return String(params[1] ?? "");
    case "claimCharacterLease":
      return String(params[1] ?? "");
    case "reportPresence":
    case "register":
    case "record":
    case "gridcast":
    case "recordFallen":
    case "recordRescued":
      return String(params[0] ?? "");
    case "shiftTide":
    case "pruneLedgerKinds":
      return headerWorld;
    default:
      return "";
  }
}

export function verifyRpcWorldAuth(
  env: Env,
  method: string,
  params: unknown[],
  headers: { world: string; worldKey: string | undefined },
): Response | null {
  if (!WORLD_AUTH_METHODS.has(method)) return null;

  const headerWorld = headers.world.trim();
  const world = worldFromRpcParams(method, params, headerWorld).trim();
  const keysRequired = worldAuthRequired(env);

  if (!world) {
    if (keysRequired || !HEADER_WORLD_METHODS.has(method)) {
      return Response.json(
        { ok: false, error: "world required (param or X-Grid-World header)" },
        { status: 400 },
      );
    }
    return null;
  }

  if (headerWorld && headerWorld !== world) {
    return Response.json({ ok: false, error: "X-Grid-World mismatch" }, { status: 403 });
  }

  if (keysRequired) {
    try {
      assertWorldAuth(env, world, headers.worldKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ ok: false, error: msg }, { status: 403 });
    }
  }

  return null;
}
