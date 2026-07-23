import { describe, expect, it } from "vitest";
import { MIN_PRESENCE_MAX_AGE_MS, effectivePresenceMaxAge } from "./presence-age";

describe("presence maxAge clamp", () => {
  it("clamps zero and negative to minimum", () => {
    expect(effectivePresenceMaxAge(0)).toBe(MIN_PRESENCE_MAX_AGE_MS);
    expect(effectivePresenceMaxAge(-1)).toBe(MIN_PRESENCE_MAX_AGE_MS);
  });

  it("passes through values above minimum", () => {
    expect(effectivePresenceMaxAge(120_000)).toBe(120_000);
  });

  it("treats non-finite as minimum", () => {
    expect(effectivePresenceMaxAge(Number.NaN)).toBe(MIN_PRESENCE_MAX_AGE_MS);
  });
});
