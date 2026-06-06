// The federation contract: the data shapes and the RPC surface the Grid Hub
// backend exposes to every world. This single file is the trust boundary made
// typed -- the hub (which IMPLEMENTS the API) and the worlds (which CALL it over
// a service binding) both build against it, so neither can drift from the other.
//
// The hub used to live as a Durable Object inside the world Worker, reached by
// `env.GRIDHUB.getByName("grid")`. It now lives in its OWN backend Worker
// (grid-hub/), and worlds reach it through a `GRID` service binding typed as
// GridHubApi. That's the move that lets genuinely SEPARATE deployments share one
// Grid: any world that binds this backend joins the same federation.
// (See docs/federation.md.)

// A notable event reported into the shared Grid memory, tagged with its world.
export type GridTrace = { world: string; node: string; kind: string; text: string; at: number };

// One line of cross-world chat, as relayed from the shared feed.
export type GridCast = { id: number; world: string; sender: string; text: string };

// The canonical, federation-wide character: the progression + standing that
// follows a player across every world. Local-only state (room, hp, position,
// inventory) is NOT here -- worlds own that.
// The canonical character that follows you across worlds. `race` is an opaque
// string: the hub carries whatever a world commits and never gatekeeps it, so any
// world (including a third party) can define its own races; a world that does not
// recognize an arriving race falls back to neutral mechanics. `ashsworn` is the
// permanent brand of an elf who joined the Cinder Front (the federation's kapo):
// once true it can never be set back to false, even on defection.
export type CharSheet = {
  level: number;
  xp: number;
  gold: number;
  faction: string;
  morality: number;
  title: string;
  race: string;
  ashsworn: boolean;
};

// A world on the federation: its name, where to connect, and when it last
// checked in (for liveness). Players `travel` between these.
export type WorldInfo = { id: string; url: string; last_seen: number };

// One of the fallen: a character who died somewhere on the Grid. The Cinder
// Front's whole method is erasure -- it rounds people into cages and scrubs the
// marks off the walls. The memorial roll is the counter: the federation keeps a
// structured record of who fell and where, so the living can refuse to forget
// them (`witness`). It carries the name directly, not parsed from prose, so the
// rite is exact across worlds.
export type Fallen = { world: string; name: string; room: string; at: number };

// The hopeful mirror of the memorial roll: one of the rescued -- a soul cut out
// of the Cinder Front's cages. The Front cages people to be forgotten; the Grid
// keeps the names of the ones who were pulled back out, and who pulled them.
export type Rescued = { world: string; name: string; savedBy: string; at: number };

// The methods a world may call on the hub. The hub's WorkerEntrypoint implements
// this; a world's `GRID` service binding is typed directly as GridHubApi, so a
// call is just `await env.GRID.record(...)` -- the same shape as the old in-Worker
// DO RPC, now crossing a deployment boundary.
export interface GridHubApi {
  // Shared Grid memory (the federation feed).
  record(world: string, node: string, kind: string, text: string, at: number): Promise<void>;
  recent(limit: number): Promise<GridTrace[]>;
  recentAcross(world: string, limit: number): Promise<GridTrace[]>;

  // The global faction tide (one needle the whole federation moves).
  tide(): Promise<number>;
  shiftTide(delta: number): Promise<number>;

  // Cross-world chat.
  gridcast(world: string, sender: string, text: string): Promise<void>;
  castsSince(sinceId: number, limit: number): Promise<GridCast[]>;

  // Canonical identity (the character that follows you across worlds).
  loadCharacter(name: string): Promise<CharSheet>;
  commitCharacter(name: string, p: CharSheet): Promise<CharSheet>;

  // The world registry (travel destinations).
  register(world: string, url: string): Promise<void>;
  listWorlds(): Promise<WorldInfo[]>;

  // Maintenance: the ledger's composition by kind, and a bounded purge. A purge
  // only ever removes the kinds it is asked for; callers (the keeper command)
  // restrict that to ambient noise so meaningful traces can never be deleted.
  ledgerStats(): Promise<Array<{ kind: string; count: number }>>;
  pruneLedgerKinds(kinds: string[]): Promise<{ removed: number }>;

  // The memorial roll: the fallen across the whole Grid, so any world can let the
  // living hold a vigil for them (`witness`). Recording is best-effort on death;
  // reading returns the most recent fallen, newest first.
  recordFallen(world: string, name: string, room: string, at: number): Promise<void>;
  recentFallen(limit: number): Promise<Fallen[]>;

  // The rescued roll: the living pulled out of the Front's cages, and who pulled
  // them. The hopeful mirror of the memorial roll; read it with `saved`.
  recordRescued(world: string, name: string, savedBy: string, at: number): Promise<void>;
  recentRescued(limit: number): Promise<Rescued[]>;
}
