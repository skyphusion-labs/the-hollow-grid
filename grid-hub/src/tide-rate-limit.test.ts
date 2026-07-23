import { describe, expect, it } from "vitest";
import { MAX_TIDE_SHIFT_PER_WINDOW, TIDE_WINDOW_MS, nextTideShift } from "./tide-rate-limit";

describe("tide rate limit", () => {
  it("allows a single max shift in a fresh window", () => {
    const now = 1_700_000_000_000;
    const r = nextTideShift(0, 0, -10, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toBe(-10);
      expect(r.windowDelta).toBe(-10);
    }
  });

  it("blocks further shifts once the window budget is exhausted", () => {
    const now = 1_700_000_000_000;
    const first = nextTideShift(0, 0, -10, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = nextTideShift(first.windowAt, first.windowDelta, -10, now + 1);
    expect(second.ok).toBe(false);
  });

  it("resets after TIDE_WINDOW_MS", () => {
    const start = 1_700_000_000_000;
    const full = nextTideShift(start, MAX_TIDE_SHIFT_PER_WINDOW, 1, start);
    expect(full.ok).toBe(false);
    const reset = nextTideShift(start, MAX_TIDE_SHIFT_PER_WINDOW, -5, start + TIDE_WINDOW_MS + 1);
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.applied).toBe(-5);
  });
});
