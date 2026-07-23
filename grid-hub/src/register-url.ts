/** Allowed schemes for world registry URLs (player travel handoff). */
const ALLOWED_REGISTER_SCHEMES = new Set(["ws:", "wss:"]);

/** Production travel handoff hosts (K3 wave 23: block arbitrary wss phishing). */
const WSS_HOST_SUFFIXES = [".skyphusion.org"];

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
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "ws:") {
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new Error("ws: register urls are limited to localhost");
    }
    return;
  }
  if (host === "skyphusion.org" || WSS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return;
  throw new Error("wss: register url host must be under skyphusion.org");
}
