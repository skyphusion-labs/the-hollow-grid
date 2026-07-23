/** Hub RPC string bounds (K3 wave 14: oversized primary keys / columns). */
export const LIMIT_CHARACTER_NAME = 32;
export const LIMIT_WORLD_ID = 64;
export const LIMIT_LEDGER_KIND = 24;
/** Max JSON body size for POST /rpc (K3 wave 20). */
export const MAX_RPC_BODY_BYTES = 65_536;

export function clampRpcString(value: unknown, max: number): string {
  const s = String(value ?? "");
  return s.length <= max ? s : s.slice(0, max);
}

/** Reject (do not truncate) primary keys like character names — avoids prefix collisions (K3 wave 17). */
export function requireRpcString(value: unknown, max: number, label = "value"): string {
  const s = String(value ?? "");
  if (s.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return s;
}
