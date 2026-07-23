import type { Env } from "./types";

type WorldKeysState = { keys: Record<string, string> | null; parseError: boolean };

function worldKeys(env: Env): WorldKeysState {
  const raw = env.GRID_WORLD_KEYS?.trim();
  if (!raw) return { keys: null, parseError: false };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [world, key] of Object.entries(obj)) {
      if (typeof key === "string" && key.length > 0) out[world] = key;
    }
    return { keys: out, parseError: false };
  } catch {
    return { keys: {}, parseError: true };
  }
}

/** Per-world keys are mandatory when RPC ingress uses a shared bearer token. */
function rpcRequiresWorldKeys(env: Env): boolean {
  return !!env.GRID_RPC_TOKEN?.trim();
}

// Production hub secrets (GRID_WORLD_KEYS) are provisioned out-of-band (fleet-chezmoi fc#1007).
// When both GRID_WORLD_KEYS and GRID_RPC_TOKEN are unset, binding auth intentionally no-ops for local dev.

export function worldAuthRequired(env: Env): boolean {
  const { keys, parseError } = worldKeys(env);
  if (parseError) return true;
  if (keys && Object.keys(keys).length > 0) return true;
  return rpcRequiresWorldKeys(env);
}

export function assertWorldAuth(env: Env, world: string, key: string | undefined): void {
  const { keys, parseError } = worldKeys(env);
  if (parseError) throw new Error("GRID_WORLD_KEYS invalid");
  if (rpcRequiresWorldKeys(env) && (!keys || Object.keys(keys).length === 0)) {
    throw new Error("GRID_WORLD_KEYS required when GRID_RPC_TOKEN is set");
  }
  if (!keys || Object.keys(keys).length === 0) return;
  const expected = keys[world];
  if (!expected || !timingSafeEqual(String(key ?? ""), expected)) {
    throw new Error(`world auth denied for ${world}`);
  }
}

/** Constant-time compare for bearer tokens and world keys. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function verifyRpcBearer(authHeader: string, token: string): boolean {
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const got = authHeader.slice(prefix.length);
  if (got.length !== token.length) return false;
  return timingSafeEqual(got, token);
}

/** Test helper: no-op (keys are read from env on each call). */
export function resetWorldAuthCache(): void {}
