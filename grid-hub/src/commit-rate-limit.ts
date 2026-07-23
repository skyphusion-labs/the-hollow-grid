/** Rolling window cap on commitCharacter calls (K3 wave 15; tightened wave 19). */
export const COMMIT_WINDOW_MS = 60_000;
export const MAX_COMMITS_PER_WINDOW = 6;
/** Total gold/xp gain allowed per commit window (K3 wave 19). */
export const MAX_GOLD_GAIN_PER_WINDOW = 500;
export const MAX_XP_GAIN_PER_WINDOW = 500;

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

export function commitGainAllowed(
  windowAt: number,
  windowGoldGain: number,
  windowXpGain: number,
  goldDelta: number,
  xpDelta: number,
  now = Date.now(),
): { ok: true; windowAt: number; windowGoldGain: number; windowXpGain: number } | { ok: false } {
  let at = windowAt;
  let goldGain = windowGoldGain;
  let xpGain = windowXpGain;
  if (now - at > COMMIT_WINDOW_MS) {
    at = now;
    goldGain = 0;
    xpGain = 0;
  }
  const nextGold = goldGain + Math.max(0, goldDelta);
  const nextXp = xpGain + Math.max(0, xpDelta);
  if (nextGold > MAX_GOLD_GAIN_PER_WINDOW || nextXp > MAX_XP_GAIN_PER_WINDOW) return { ok: false };
  return { ok: true, windowAt: at, windowGoldGain: nextGold, windowXpGain: nextXp };
}
