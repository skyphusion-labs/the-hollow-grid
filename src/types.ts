import type { World } from "./world";

export interface Env {
  WORLD: DurableObjectNamespace<World>;
}

/**
 * Per-connection state stored on the WebSocket itself via
 * `ws.serializeAttachment()`. This is the key to hibernation: the DO can be
 * evicted from memory while sockets stay open, so we must NOT keep connection
 * state in plain instance fields — it would be lost. The attachment survives
 * hibernation and comes back with the socket.
 */
export interface Session {
  /** empty string until the player has chosen a name */
  name: string;
  /** room id the player is currently in */
  room: string;
}
