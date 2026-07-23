import type { Env } from "./types";
import { assertWorldAuth, worldAuthRequired } from "./world-auth";

/** Service-binding entrypoints call this before mutating federation state. */
export function requireBindingWorldAuth(env: Env, world: string | undefined, worldKey?: string): void {
  if (!worldAuthRequired(env)) return;
  const w = world?.trim();
  if (!w) throw new Error("world required");
  assertWorldAuth(env, w, worldKey);
}
