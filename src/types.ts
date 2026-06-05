import type { World } from "./world";
import type { GridHubApi } from "../shared/grid";

export interface Env {
  WORLD: DurableObjectNamespace<World>;
  /**
   * The federation backend, reached over a SERVICE BINDING (RPC) rather than a
   * local DO: a separate Worker (grid-hub/) owns the shared Grid, so any world
   * that binds it joins the same federation. Typed as the contract it exposes.
   * (See shared/grid.ts and docs/federation.md.)
   */
  GRID: GridHubApi;
  /** Comma-separated player names allowed to `wall` (server-wide announcements). */
  ADMINS?: string;
  /** This world's public WebSocket URL, advertised to the federation registry. */
  WORLD_URL?: string;
  /**
   * This world's name on the federation (defaults to "The Hollow Grid"). Set it
   * per deployment so the same code can run as two distinct worlds on one Grid,
   * each registering under its own name. (See world.ts worldName.)
   */
  WORLD_NAME?: string;
  /**
   * Which room map this deployment serves (e.g. "dustfall"); unset = the Hollow
   * Grid. Lets one codebase present as different places. (See rooms.ts mapFor.)
   */
  WORLD_MAP?: string;
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
  /** federated race id, chosen once at creation; "" until chosen (see src/races.ts) */
  race: string;
  /** the permanent kapo brand: an elf who joined the Front. Once true, never false. */
  ashsworn: boolean;
  /** whether the player has consciously resisted the tavern's vices */
  resisted: boolean;
  /** name of the last player who `tell`-ed us, for `reply` (in-memory only) */
  replyTo?: string;
  /** body position: standing (default) | sitting | resting | sleeping (in-memory) */
  position?: string;
  /** when the racial ability is next usable, epoch ms (in-memory; resets on relogin) */
  traitReadyAt?: number;
  /** a custom title shown after the player's name (persisted) */
  title?: string;
}
