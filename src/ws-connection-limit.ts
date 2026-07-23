/** WebSocket admission limits on the shared World DO (K3 wave 24). */
export const MAX_WS_CONNECTIONS = 512;
export const MAX_WS_CONNECTIONS_PER_IP = 16;
/** Close sockets that never complete login within this window. */
export const PREAUTH_IDLE_MS = 90_000;

export function wsClientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

export function countIpFromSessions(sessions: Array<{ clientIp?: string } | null>, ip: string): number {
  return sessions.filter((s) => s?.clientIp === ip).length;
}

export function shouldClosePreauth(session: { name?: string; connectedAt?: number } | null, now: number): boolean {
  if (!session || session.name) return false;
  const at = session.connectedAt ?? 0;
  return at > 0 && now - at > PREAUTH_IDLE_MS;
}
