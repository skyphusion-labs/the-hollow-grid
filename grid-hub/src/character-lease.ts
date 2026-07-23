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

/** commitCharacter: caller must already hold the active lease (no implicit grant). */
export function requireActiveCharacterLease(name: string, leaseWorld: string, callerWorld: string): void {
  const lease = leaseWorld.trim();
  if (lease === callerWorld) return;
  if (lease) throw new Error(`character ${name} is leased to ${lease}, not ${callerWorld}`);
  throw new Error(`character ${name} has no active lease on ${callerWorld}; claimCharacterLease first`);
}

/** claimCharacterLease: new row, same-world renewal, or home still unset only. */
export function assertClaimCharacterLeaseAllowed(
  name: string,
  leaseWorld: string,
  homeWorld: string,
  callerWorld: string,
): void {
  const home = homeWorld.trim();
  const lease = leaseWorld.trim();
  if (home && home !== callerWorld) {
    throw new Error(`character ${name} home world is ${home}, cannot claim from ${callerWorld}`);
  }
  if (lease && lease !== callerWorld) {
    throw new Error(`character ${name} is leased to ${lease}, not ${callerWorld}`);
  }
}

/** True when another world still holds a non-expired commit lease. */
export function hasActiveLeaseElsewhere(
  leaseWorld: string,
  leaseAt: number | null | undefined,
  callerWorld: string,
  now = Date.now(),
): boolean {
  const lease = leaseWorld.trim();
  if (!lease || lease === callerWorld) return false;
  if (leaseAt && leaseAt > 0 && leaseAt >= leaseExpiryCutoff(now)) return true;
  return isLegacyUntimestampedLease(leaseWorld, leaseAt);
}

/** Block keyed-world claims while the name is live on another world's roster. */
export function assertNoCrossWorldPresence(
  name: string,
  callerWorld: string,
  presenceWorld: string | undefined,
): void {
  const world = presenceWorld?.trim() ?? "";
  if (world && world !== callerWorld) {
    throw new Error(`character ${name} is present on ${world}, cannot claim from ${callerWorld}`);
  }
}
