# The Hollow Grid architecture

How the reference server is built, and the design rules a port should preserve.
For the wire format and contracts, see `docs/protocol.md`; for adding content,
`docs/worlds.md`; for running it, `docs/deploy.md`.

## The shape of it

```
client (browser xterm / wscat / bot) --wss--> World Worker (src/index.ts)
                                                  |  GET /     -> in-browser play client
                                                  |  GET /ws   -> the World Durable Object
                                                  v
                                        World DO (src/world.ts)
                                          - WebSocket Hibernation
                                          - SQLite (players, mobs, inventory, ground, world)
                                          - one alarm drives all time-based mechanics
                                                  |  env.GRID (RPC service binding)
                                                  v
                                        Grid Hub Worker (grid-hub/)
                                          - GridHub DO: tide, ledger, chat, characters, registry
                                          - GridHubService: the GridHubApi entrypoint
```

One World Worker per world; one shared Grid Hub Worker for the whole federation.
The contract between them is `shared/grid.ts` (see `docs/protocol.md` section 3).

## Five design rules a port should keep

These are the load-bearing decisions, mined from a buggier MUD the author wanted
to one-up. They are why the game is testable, tool-able, and pleasant.

1. **One Durable Object holds the whole game.** Every player routes to the same
   `World` instance (`getByName("world")`), so the world is naturally
   consistent: no cross-shard coordination, no race between players in a room. A
   port does not need Durable Objects specifically, but it should keep a single
   authoritative game loop per world.

2. **Connection state lives on the socket, not in memory.** Cloudflare's
   WebSocket Hibernation API can evict the DO from memory while sockets stay
   open. Per-player `Session` state (name, room, vitals, target, gold, faction,
   ...) rides on each socket via `serializeAttachment()`; "who is online / who is
   in room X" is always derived by scanning live sockets. Nothing player-facing
   is cached in plain fields, so the DO can sleep when idle and wake on demand.
   A port on a long-running process can hold state in memory, but the discipline
   (derive presence from connections; persist durable state) still applies.

3. **A single timer drives every time-based mechanic.** One DO `alarm()` fires
   every `ROUND_MS` (3s) while anyone is online and each tick: respawns due mobs,
   drains HP from the afflicted, resolves one combat round per fight, and
   advances the living world (`worldTick`: day/night, weather, the faction tide,
   a wandering Grid-ghost). The timer stops when the last player leaves (so the
   world hibernates) and restarts on the next login. Add timed effects to this
   one loop, not a parallel scheduler.

4. **Structured state is the source of truth, prose is a view.** Every canonical
   state change is emitted on the `@event` channel (see `docs/protocol.md`), and
   the smoke suite asserts on those events, never on English. The rule: if a
   client/bot/test would need it, it is an event, not prose-only. This is the
   single most important rule for keeping the game machine-readable.

5. **The engine is generic; the game is data.** Rooms, mobs, items, banners, and
   shop stock are data files selected per deployment. The engine has no hardcoded
   content. Adding a zone, a creature, or a whole new world is a data change. See
   `docs/worlds.md`.

Bonus rule, the one that named the no-silent-no-op design: **an exit only exists
if it is declared.** Movement either follows a declared exit or returns a clear
"you can't go that way." A phantom, unusable exit was the original-sin bug that
motivated the whole project; the engine refuses to reproduce it.

## Persistence

SQLite tables, created in the DO constructor under `blockConcurrencyWhile`:

- `players` -- name, room, vitals, gold, morality, addiction, faction, title.
- `mobs` -- per-instance dynamic state (current hp, alive/dead, respawn_at),
  seeded one row per mob template.
- `inventory` -- per-player item stacks.
- `ground` -- per-room item piles (loot drops land here).
- `world` -- a single row: the living-world state (tick, phase, weather, tide).

During early development, schema changes use a guarded `ALTER TABLE ADD COLUMN`
loop (try/catch per column) so existing local DBs upgrade in place, rather than
formal migrations. The only federated state (identity, tide, ledger, chat,
registry) lives in the Grid Hub, not here.

## The command set

Commands are single line verbs (many with short aliases). Grouped:

- **Movement / look:** `look` (`l`), `go`/`<direction>`, `exits`, `examine`
  (`exa`), `consider` (`con`), `recall`, `home`, `travel`, `worlds`.
- **Combat:** `attack`/`kill` (`k`), `flee` (`f`), `steal`.
- **Equipment / items:** `get`/`take`, `drop`, `give`, `wear`/`wield`,
  `remove`/`unwield`, `equipment` (`eq`), `inventory` (`i`/`inv`), `use`,
  `list`, `buy`, `sell`.
- **Positions:** `stand`, `sit`, `rest`, `sleep` (regen HP; you cannot mid-fight).
- **Comms:** `say`, `tell`, `reply`, `yell`/`shout`, `emote` (`pose`/`em`),
  `gridcast` (`gc`).
- **For each other:** `give <item> <player>`, `mend <player>` (heal another at a
  cost to your own HP), `inscribe`/`carve` (leave a message in the Grid).
- **Info:** `who`, `status` (`st`), `affects` (`affs`), `hp`, `time`, `weather`,
  `war`, `tide`, `identity`/`whoami`, `help` (`?`).
- **Racial ability:** `ability`/`trait` (or the race's named verb, e.g. `vanish`,
  `overclock`, `forage`) activates your race's signature ability.
- **The faction arc:** `join`, `defend`/`defy` (side with the free folk),
  `free`/`rescue` (free caged refugees), `talk`, `resist`.
- **The world / drugs:** `drink`, `eat`, `carouse`, `ping`, `title`.
- **The dead network:** `listen`/`tune` (tune the dead frequencies for a Grid
  transmission; the network also bleeds fragments on the living-world tick).
- **Admin (keepers in the `ADMINS` var):** `wall`/`announce`.

A faithful port should implement these verbs and emit the matching `@event`s. The
authoritative list is the dispatch in `src/world.ts`.

## Repo layout

```
src/index.ts      Worker entry: routes / (play client) and /ws (the DO)
src/world.ts      the World Durable Object: the whole game loop
src/types.ts      Env (bindings + vars) and the per-socket Session
src/rooms.ts      room maps + mapFor() + per-world intro
src/mobs.ts       mob templates + per-world bestiary (mobsFor)
src/items.ts      item catalog + per-world shop stock / starter (waresFor, starterFor)
src/races.ts      player races: roster, Front stance, light leans (a federated attribute)
src/banner.ts     per-world ANSI login banners (bannerFor)
src/webclient.ts  the in-browser xterm.js play client (served from /)
shared/grid.ts    THE federation contract (GridHubApi + data types)
grid-hub/         the Grid Hub backend Worker (GridHub DO + GridHubService)
smoke.mjs         end-to-end test harness over the @event channel
scripts/connect.mjs   dependency-free terminal client
bot.mjs           an AI player driven by the @event channel
```
