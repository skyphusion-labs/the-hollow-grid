function isUnicodeFormatChar(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    code === 0xfeff ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Strip control chars and newlines from player-authored prose (ANSI/@event injection guard). */
export function sanitizePlayerText(s: string, maxLen = 500): string {
  let out = "";
  for (const ch of s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")) {
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n" || ch === "\t") {
      out += " ";
      continue;
    }
    if (code < 0x20 || code === 0x7f || isUnicodeFormatChar(code)) continue;
    out += ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}
