import type { Env } from "./types";

// The Durable Object class must be exported from the Worker entry module.
// (The Grid Hub is no longer here -- it lives in its own backend Worker,
// grid-hub/, reached through the GRID service binding. See docs/federation.md.)
export { World } from "./world";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // One shared world instance. Everyone routes to the same DO.
      const stub = env.WORLD.getByName("world");
      return stub.fetch(request);
    }

    return new Response(
      "THE HOLLOW GRID: a MUD on Cloudflare Workers.\n" +
        "Connect a WebSocket to /ws (e.g. `wscat -c ws://localhost:8787/ws`).\n",
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
