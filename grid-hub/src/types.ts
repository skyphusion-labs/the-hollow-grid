import type { GridHub } from "./gridhub";

export interface Env {
  /** The single global Grid Hub Durable Object: the federation's shared state. */
  GRIDHUB: DurableObjectNamespace<GridHub>;
}
