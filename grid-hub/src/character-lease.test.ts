import { describe, expect, it } from "vitest";
import { LEASE_TTL_MS, isLegacyUntimestampedLease, leaseExpiryCutoff } from "./character-lease";

describe("character lease helpers", () => {
  it("leaseExpiryCutoff is LEASE_TTL_MS before now", () => {
    const now = 1_700_000_000_000;
    expect(leaseExpiryCutoff(now)).toBe(now - LEASE_TTL_MS);
  });

  it("flags legacy leases without lease_at", () => {
    expect(isLegacyUntimestampedLease("Dustfall", 0)).toBe(true);
    expect(isLegacyUntimestampedLease("Dustfall", null)).toBe(true);
    expect(isLegacyUntimestampedLease("Dustfall", undefined)).toBe(true);
    expect(isLegacyUntimestampedLease("", 0)).toBe(false);
    expect(isLegacyUntimestampedLease("Dustfall", Date.now())).toBe(false);
  });
});
