/** Active commit leases expire so crash/disconnect cannot lock a name forever. */
export const LEASE_TTL_MS = 30 * 60 * 1000;

/** SQL cutoff: rows with lease_at older than this are stale. */
export function leaseExpiryCutoff(now = Date.now()): number {
  return now - LEASE_TTL_MS;
}

/** Legacy rows may have lease_world set but no lease_at (pre-wave-13); treat as expired. */
export function isLegacyUntimestampedLease(leaseWorld: string, leaseAt: number | null | undefined): boolean {
  return !!leaseWorld.trim() && !leaseAt;
}
