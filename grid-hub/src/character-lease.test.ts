import { describe, expect, it } from "vitest";
import { LEASE_TTL_MS, assertClaimCharacterLeaseAllowed, assertNoCrossWorldPresence, hasActiveLeaseElsewhere, isLegacyUntimestampedLease, leaseExpiryCutoff, requireActiveCharacterLease } from "./character-lease";

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

describe("requireActiveCharacterLease", () => {
  it("accepts matching lease holder", () => {
    expect(() => requireActiveCharacterLease("Mara", "Dustfall", "Dustfall")).not.toThrow();
  });

  it("rejects empty lease without implicit grant", () => {
    expect(() => requireActiveCharacterLease("Mara", "", "Dustfall")).toThrow(/no active lease/);
  });

  it("rejects another world's lease", () => {
    expect(() => requireActiveCharacterLease("Mara", "Hollow", "Dustfall")).toThrow(/leased to Hollow/);
  });
});

describe("assertClaimCharacterLeaseAllowed", () => {
  it("allows same-world renewal after expiry", () => {
    expect(() => assertClaimCharacterLeaseAllowed("Mara", "", "Dustfall", "Dustfall")).not.toThrow();
  });

  it("blocks cross-world claim when home is pinned", () => {
    expect(() => assertClaimCharacterLeaseAllowed("Mara", "", "Hollow", "Dustfall")).toThrow(/home world is Hollow/);
  });

  it("blocks stealing an active lease", () => {
    expect(() => assertClaimCharacterLeaseAllowed("Mara", "Hollow", "Dustfall", "Dustfall")).toThrow(
      /leased to Hollow/,
    );
  });
});

describe("hasActiveLeaseElsewhere", () => {
  it("detects a fresh lease on another world", () => {
    const now = 1_700_000_000_000;
    expect(hasActiveLeaseElsewhere("Hollow", now, "Dustfall", now)).toBe(true);
  });

  it("ignores expired leases", () => {
    const now = 1_700_000_000_000;
    expect(hasActiveLeaseElsewhere("Hollow", leaseExpiryCutoff(now) - 1, "Dustfall", now)).toBe(false);
  });
});

describe("assertNoCrossWorldPresence", () => {
  it("blocks when another world reports the name online", () => {
    expect(() => assertNoCrossWorldPresence("Mara", "Dustfall", "Hollow")).toThrow(/present on Hollow/);
  });

  it("allows same-world presence", () => {
    expect(() => assertNoCrossWorldPresence("Mara", "Dustfall", "Dustfall")).not.toThrow();
  });
});
