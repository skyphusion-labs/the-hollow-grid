/** Per-world rolling cap on shiftTide magnitude (K3 wave 19). */
export const TIDE_WINDOW_MS = 60_000;
export const MAX_TIDE_SHIFT_PER_WINDOW = 10;

export function nextTideShift(
  windowAt: number,
  windowDelta: number,
  delta: number,
  now = Date.now(),
): { ok: true; windowAt: number; windowDelta: number; applied: number } | { ok: false } {
  let at = windowAt;
  let accum = windowDelta;
  if (now - at > TIDE_WINDOW_MS) {
    at = now;
    accum = 0;
  }
  const d = Math.floor(delta);
  if (!Number.isFinite(d) || d === 0) {
    return { ok: true, windowAt: at, windowDelta: accum, applied: 0 };
  }
  const headroom = MAX_TIDE_SHIFT_PER_WINDOW - Math.abs(accum);
  if (headroom <= 0) return { ok: false };
  const applied = Math.max(-headroom, Math.min(headroom, d));
  if (applied === 0) return { ok: false };
  return { ok: true, windowAt: at, windowDelta: accum + applied, applied };
}
