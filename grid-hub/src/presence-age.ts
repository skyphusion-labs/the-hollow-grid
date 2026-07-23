/** Minimum presence TTL so maxAgeMs=0 cannot wipe the federated roster (K3 wave 15). */
export const MIN_PRESENCE_MAX_AGE_MS = 60_000;

export function effectivePresenceMaxAge(maxAgeMs: number): number {
  if (!Number.isFinite(maxAgeMs)) return MIN_PRESENCE_MAX_AGE_MS;
  return Math.max(MIN_PRESENCE_MAX_AGE_MS, Math.floor(maxAgeMs));
}
