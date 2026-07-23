/** Allowed schemes for world registry URLs (player travel handoff). */
const ALLOWED_REGISTER_SCHEMES = new Set(["ws:", "wss:"]);

export function assertRegisterUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("register url is not a valid URL");
  }
  if (!ALLOWED_REGISTER_SCHEMES.has(parsed.protocol)) {
    throw new Error("register url must use ws: or wss:");
  }
}
