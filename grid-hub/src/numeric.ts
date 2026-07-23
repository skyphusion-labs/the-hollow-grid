/** Coerce to integer; non-finite input keeps the fallback (NaN/Infinity guard). */
export function finiteInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  const floored = Math.floor(n);
  return Number.isFinite(floored) ? floored : fallback;
}
