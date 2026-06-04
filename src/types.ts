import type { World } from "./world";

export interface Env {
  WORLD: DurableObjectNamespace<World>;
}

/**
 * Per-connection state stored on the WebSocket itself via
 * `ws.serializeAttachment()`. This is the key to hibernation: the DO can be
 * evicted from memory while sockets stay open, so we must NOT keep connection
 * state in plain instance fields; it would be lost. The attachment survives
 * hibernation and comes back with the socket.
 */
export interface Session {
  /** empty string until the player has chosen a name */
  name: string;
  /** room id the player is currently in */
  room: string;
  /** current / maximum hit points */
  hp: number;
  maxHp: number;
  /** experience and level */
  xp: number;
  level: number;
  /** id of the mob instance this player is fighting, or null */
  target: string | null;
  /** whether the player is currently poisoned/afflicted (drains hp each tick) */
  poisoned: boolean;
  /** currency */
  gold: number;
  /** moral standing: positive = virtuous, negative = corrupt */
  morality: number;
  /** number of times the player has used dust (drug) */
  addiction: number;
  /** stance toward the Cinder Front: "none" | "front" | "ally" */
  faction: "none" | "front" | "ally";
  /** whether the player has consciously resisted the tavern's vices */
  resisted: boolean;
}
