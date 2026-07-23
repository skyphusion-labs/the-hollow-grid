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

/** JSON-RPC params must be plain objects (not arrays/null). */
export function requireRpcObject(value: unknown, label = "param"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Bounded integer coercion for numeric RPC params (K3 wave 23). */
export function clampRpcInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
