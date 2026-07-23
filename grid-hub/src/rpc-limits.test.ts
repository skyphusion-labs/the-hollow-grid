import { describe, expect, it } from "vitest";
import { clampRpcInt, clampRpcString, LIMIT_CHARACTER_NAME, LIMIT_WORLD_ID, requireRpcObject, requireRpcString } from "./rpc-limits";

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

describe("requireRpcObject", () => {
  it("rejects non-objects", () => {
    expect(() => requireRpcObject(null, "character sheet")).toThrow(/must be an object/);
    expect(() => requireRpcObject([], "character sheet")).toThrow(/must be an object/);
  });

  it("accepts plain objects", () => {
    expect(requireRpcObject({ level: 1 }, "character sheet")).toEqual({ level: 1 });
  });
});

describe("clampRpcInt", () => {
  it("clamps and floors finite numbers", () => {
    expect(clampRpcInt(12.9, 1, 50, 20)).toBe(12);
    expect(clampRpcInt(999, 1, 50, 20)).toBe(50);
  });

  it("uses fallback for non-finite input", () => {
    expect(clampRpcInt("nope", 1, 50, 20)).toBe(20);
    expect(clampRpcInt(undefined, 1, 50, 20)).toBe(20);
  });
});
