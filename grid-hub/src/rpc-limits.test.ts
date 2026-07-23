import { describe, expect, it } from "vitest";
import { clampRpcString, LIMIT_CHARACTER_NAME, LIMIT_WORLD_ID, requireRpcString } from "./rpc-limits";

describe("clampRpcString", () => {
  it("passes through strings within limit", () => {
    expect(clampRpcString("Mara", LIMIT_CHARACTER_NAME)).toBe("Mara");
  });

  it("truncates oversized values", () => {
    const long = "w".repeat(100);
    expect(clampRpcString(long, LIMIT_WORLD_ID).length).toBe(LIMIT_WORLD_ID);
  });

  it("coerces non-strings", () => {
    expect(clampRpcString(undefined, 8)).toBe("");
    expect(clampRpcString(42, 8)).toBe("42");
  });
});

describe("requireRpcString", () => {
  it("rejects oversized character names instead of truncating", () => {
    const long = "n".repeat(LIMIT_CHARACTER_NAME + 1);
    expect(() => requireRpcString(long, LIMIT_CHARACTER_NAME, "character name")).toThrow(/exceeds 32/);
  });
});
