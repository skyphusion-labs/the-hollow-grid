import { describe, expect, it } from "vitest";
import { COMMIT_WINDOW_MS, MAX_COMMITS_PER_WINDOW, nextCommitWindow } from "./commit-rate-limit";

describe("commit rate limit", () => {
  it("allows commits within the window", () => {
    const now = 1_700_000_000_000;
    let at = now;
    let count = 0;
    for (let i = 0; i < MAX_COMMITS_PER_WINDOW; i++) {
      const next = nextCommitWindow(at, count, now + i);
      expect(next.ok).toBe(true);
      if (next.ok) {
        at = next.windowAt;
        count = next.windowCount;
      }
    }
    expect(nextCommitWindow(at, count, now + MAX_COMMITS_PER_WINDOW).ok).toBe(false);
  });

  it("resets the window after COMMIT_WINDOW_MS", () => {
    const start = 1_700_000_000_000;
    const full = nextCommitWindow(start, MAX_COMMITS_PER_WINDOW - 1, start);
    expect(full.ok).toBe(true);
    const blocked = nextCommitWindow(start, MAX_COMMITS_PER_WINDOW, start + 1);
    expect(blocked.ok).toBe(false);
    const reset = nextCommitWindow(start, MAX_COMMITS_PER_WINDOW, start + COMMIT_WINDOW_MS + 1);
    expect(reset.ok).toBe(true);
  });
});
