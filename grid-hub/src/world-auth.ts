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

export function worldAuthRequired(env: Env): boolean {
  const { keys, parseError } = worldKeys(env);
  if (parseError) return true;
  return !!keys && Object.keys(keys).length > 0;
}

export function assertWorldAuth(env: Env, world: string, key: string | undefined): void {
  const { keys, parseError } = worldKeys(env);
  if (parseError) throw new Error("GRID_WORLD_KEYS invalid");
  if (!keys || Object.keys(keys).length === 0) return;
  const expected = keys[world];
  if (!expected || !timingSafeEqual(String(key ?? ""), expected)) {
    throw new Error(`world auth denied for ${world}`);
  }
}

/** Test helper: no-op (keys are read from env on each call). */
export function resetWorldAuthCache(): void {}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
