import bcrypt from "bcryptjs";

const MIN_LEN = 8;
const MAX_LEN = 128;
/** bcrypt only hashes the first 72 UTF-8 bytes; reject longer inputs (K3 wave 21). */
const BCRYPT_MAX_BYTES = 72;

function phraseByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export async function hashPassphrase(phrase: string): Promise<string> {
  const trimmed = phrase.trim();
  if (trimmed.length < MIN_LEN) throw new Error("passphrase too short");
  if (trimmed.length > MAX_LEN) throw new Error("passphrase too long");
  if (phraseByteLength(trimmed) > BCRYPT_MAX_BYTES) throw new Error("passphrase too long for bcrypt");
  return bcrypt.hash(trimmed, bcrypt.genSaltSync(10));
}

export async function verifyPassphrase(phrase: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  const trimmed = phrase.trim();
  if (trimmed.length > MAX_LEN) return false;
  if (phraseByteLength(trimmed) > BCRYPT_MAX_BYTES) return false;
  return bcrypt.compare(trimmed, storedHash);
}

function bytesTimingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const lenA = a.length;
  const lenB = b.length;
  const max = Math.max(lenA, lenB);
  let out = lenA ^ lenB;
  for (let i = 0; i < max; i++) {
    const ca = i < lenA ? a[i] : 0;
    const cb = i < lenB ? b[i] : 0;
    out |= ca ^ cb;
  }
  return out === 0;
}

export function verifyAdminToken(token: string, expected: string): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(token.trim());
  const b = new TextEncoder().encode(expected);
  return bytesTimingSafeEqual(a, b);
}
