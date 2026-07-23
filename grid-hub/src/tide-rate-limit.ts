/** Per-world rolling cap on shiftTide magnitude (K3 wave 19). */
export const TIDE_WINDOW_MS = 60_000;
export const MAX_TIDE_SHIFT_PER_WINDOW = 10;

export function nextTideShift(
  windowAt: number,
  windowPos: number,
  windowNeg: number,
  delta: number,
  now = Date.now(),
): { ok: true; windowAt: number; windowPos: number; windowNeg: number; applied: number } | { ok: false } {
  let at = windowAt;
  let pos = windowPos;
  let neg = windowNeg;
  if (now - at > TIDE_WINDOW_MS) {
    at = now;
    pos = 0;
    neg = 0;
  }
  const d = Math.floor(delta);
  if (!Number.isFinite(d) || d === 0) {
    return { ok: true, windowAt: at, windowPos: pos, windowNeg: neg, applied: 0 };
  }
  if (d > 0) {
    const headroom = MAX_TIDE_SHIFT_PER_WINDOW - pos;
    if (headroom <= 0) return { ok: false };
    const applied = Math.min(headroom, Math.min(MAX_TIDE_SHIFT_PER_WINDOW, d));
    if (applied === 0) return { ok: false };
    return { ok: true, windowAt: at, windowPos: pos + applied, windowNeg: neg, applied };
  }
  const headroom = MAX_TIDE_SHIFT_PER_WINDOW - neg;
  if (headroom <= 0) return { ok: false };
  const applied = -Math.min(headroom, Math.min(MAX_TIDE_SHIFT_PER_WINDOW, -d));
  if (applied === 0) return { ok: false };
  return { ok: true, windowAt: at, windowPos: pos, windowNeg: neg + -applied, applied };
}

/** @deprecated signed accum replaced by window_pos/window_neg; kept for tests migrating off window_delta */
export const MAX_TIDE_SHIFT = MAX_TIDE_SHIFT_PER_WINDOW;
