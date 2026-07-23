/** Rolling window cap on commitCharacter calls (K3 wave 15). */
export const COMMIT_WINDOW_MS = 60_000;
export const MAX_COMMITS_PER_WINDOW = 10;

export type CommitWindow = { windowAt: number; windowCount: number };

export function nextCommitWindow(
  windowAt: number,
  windowCount: number,
  now = Date.now(),
): { ok: true; windowAt: number; windowCount: number } | { ok: false } {
  let at = windowAt;
  let count = windowCount;
  if (now - at > COMMIT_WINDOW_MS) {
    at = now;
    count = 0;
  }
  if (count >= MAX_COMMITS_PER_WINDOW) return { ok: false };
  return { ok: true, windowAt: at, windowCount: count + 1 };
}
