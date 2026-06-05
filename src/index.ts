import type { Env } from "./types";
import { playPage } from "./webclient";

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

    // Anything else: serve the browser play client (it connects back to /ws on
    // this same host, so each world serves its own playable terminal).
    return new Response(playPage(env.WORLD_NAME ?? "The Hollow Grid"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
