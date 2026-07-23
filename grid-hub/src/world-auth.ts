import type { Env } from "./types";

let parsedKeys: Record<string, string> | null | undefined;
let keysParseError = false;

function worldKeys(env: Env): Record<string, string> | null {
  if (parsedKeys !== undefined) return parsedKeys;
  const raw = env.GRID_WORLD_KEYS?.trim();
  if (!raw) {
    parsedKeys = null;
    return parsedKeys;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [world, key] of Object.entries(obj)) {
      if (typeof key === "string" && key.length > 0) out[world] = key;
    }
    parsedKeys = out;
    return parsedKeys;
  } catch {
    keysParseError = true;
    parsedKeys = {};
    return parsedKeys;
  }
}

export function worldAuthRequired(env: Env): boolean {
  const keys = worldKeys(env);
  if (keysParseError) return true;
  return !!keys && Object.keys(keys).length > 0;
}

export function assertWorldAuth(env: Env, world: string, key: string | undefined): void {
  if (keysParseError) throw new Error("GRID_WORLD_KEYS invalid");
  const keys = worldKeys(env);
  if (!keys || Object.keys(keys).length === 0) return;
  const expected = keys[world];
  if (!expected || !timingSafeEqual(String(key ?? ""), expected)) {
    throw new Error(`world auth denied for ${world}`);
  }
}

/** Test helper: reset module cache between cases. */
export function resetWorldAuthCache(): void {
  parsedKeys = undefined;
  keysParseError = false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
