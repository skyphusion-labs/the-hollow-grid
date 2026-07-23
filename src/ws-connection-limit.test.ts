import { describe, expect, it } from "vitest";
import {
  MAX_WS_CONNECTIONS_PER_IP,
  PREAUTH_IDLE_MS,
  countIpFromSessions,
  shouldClosePreauth,
  wsClientIp,
} from "./ws-connection-limit";

describe("ws-connection-limit", () => {
  it("reads CF-Connecting-IP", () => {
    const req = new Request("https://hollow/ws", { headers: { "CF-Connecting-IP": " 203.0.113.7 " } });
    expect(wsClientIp(req)).toBe("203.0.113.7");
  });

  it("falls back when CF-Connecting-IP missing", () => {
    expect(wsClientIp(new Request("https://hollow/ws"))).toBe("unknown");
  });

  it("counts sessions per IP", () => {
    const sessions = [
      { clientIp: "1.2.3.4" },
      { clientIp: "1.2.3.4" },
      { clientIp: "5.6.7.8" },
      null,
    ];
    expect(countIpFromSessions(sessions, "1.2.3.4")).toBe(2);
    expect(countIpFromSessions(sessions, "9.9.9.9")).toBe(0);
  });

  it("closes idle pre-auth sockets", () => {
    const now = 100_000;
    expect(shouldClosePreauth({ name: "", connectedAt: now - PREAUTH_IDLE_MS - 1 }, now)).toBe(true);
    expect(shouldClosePreauth({ name: "", connectedAt: now - 1000 }, now)).toBe(false);
    expect(shouldClosePreauth({ name: "Mara", connectedAt: now - PREAUTH_IDLE_MS - 1 }, now)).toBe(false);
  });

  it("exports sane per-IP cap", () => {
    expect(MAX_WS_CONNECTIONS_PER_IP).toBeGreaterThan(0);
    expect(MAX_WS_CONNECTIONS_PER_IP).toBeLessThan(512);
  });
});
