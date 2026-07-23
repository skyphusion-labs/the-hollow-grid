/** Hub RPC string bounds (K3 wave 14: oversized primary keys / columns). */
export const LIMIT_CHARACTER_NAME = 32;
export const LIMIT_WORLD_ID = 64;
export const LIMIT_LEDGER_KIND = 24;

export function clampRpcString(value: unknown, max: number): string {
  const s = String(value ?? "");
  return s.length <= max ? s : s.slice(0, max);
}
