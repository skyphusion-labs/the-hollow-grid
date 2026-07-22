import type { GridHub } from "./gridhub";

export interface Env {
  /** The single global Grid Hub Durable Object: the federation's shared state. */
  GRIDHUB: DurableObjectNamespace<GridHub>;
  /** Bearer token for external nodes calling POST /rpc (fleet Go worlds). */
  GRID_RPC_TOKEN?: string;
  /** JSON map of world name -> per-world key for mutating RPC (K3 #86). */
  GRID_WORLD_KEYS?: string;
}
