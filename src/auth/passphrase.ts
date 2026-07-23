import bcrypt from "bcryptjs";

const MIN_LEN = 8;
const MAX_LEN = 128;

export async function hashPassphrase(phrase: string): Promise<string> {
  const trimmed = phrase.trim();
  if (trimmed.length < MIN_LEN) throw new Error("passphrase too short");
  if (trimmed.length > MAX_LEN) throw new Error("passphrase too long");
  return bcrypt.hash(trimmed, bcrypt.genSaltSync(10));
}

export async function verifyPassphrase(phrase: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  const trimmed = phrase.trim();
  if (trimmed.length > MAX_LEN) return false;
  return bcrypt.compare(trimmed, storedHash);
}

function bytesTimingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function verifyAdminToken(token: string, expected: string): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(token.trim());
  const b = new TextEncoder().encode(expected);
  return bytesTimingSafeEqual(a, b);
}
