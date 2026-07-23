/** CSWSH guard: browser WebSocket upgrades must match request Host (K3 wave 20). */
export function assertAllowedWsOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return; // CLI clients (wscat, smoke, mud-bots) omit Origin
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new Error("invalid Origin");
  }
  const requestHost = new URL(request.url).host;
  if (originHost !== requestHost) {
    throw new Error("Origin not allowed");
  }
}
