import { describe, expect, it } from "vitest";
import { finiteInt } from "./numeric";

describe("finiteInt", () => {
  it("floors finite numbers", () => {
    expect(finiteInt(3.9, 0)).toBe(3);
  });

  it("returns fallback for NaN", () => {
    expect(finiteInt(Number.NaN, 7)).toBe(7);
    expect(finiteInt("not-a-number", 7)).toBe(7);
  });

  it("returns fallback for Infinity", () => {
    expect(finiteInt(Number.POSITIVE_INFINITY, 2)).toBe(2);
  });
});
