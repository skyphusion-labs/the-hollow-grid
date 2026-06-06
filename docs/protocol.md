# The Hollow Grid protocol

This is the wire and contract specification for The Hollow Grid, written to be
**language-agnostic** so the server (or a client, bot, or a whole federated
world) can be reimplemented in any language. The reference implementation is
TypeScript on Cloudflare Workers, but nothing here depends on that; a port in
Go, Rust, Python, Elixir, or anything else that speaks WebSocket and JSON is a
first-class citizen of the same Grid.

There are three contracts:

1. **The player transport** -- how a client connects and plays (WebSocket text).
2. **The structured `@event` channel** -- machine-readable game state alongside
   the prose, so clients/bots/tests never scrape English.
3. **The federation contract (`GridHubApi`)** -- the RPC surface a Grid Hub
   backend exposes to worlds, so independent deployments share one universe.

## 1. Player transport

- **WebSocket, plain UTF-8 text.** Connect to `/ws` on a world's host. There is
  no binary framing, no length prefix, no auth handshake: a raw client like
  `wscat -c wss://hollow.skyphusion.org/ws` works as a game client.
- **Lines are CRLF (`\r\n`).** The server sends prose and prompts terminated
  with `\r\n` so telnet/terminal clients render cleanly.
- **A message from the client is one command line.** Send `look\n` (or with a
  trailing `\r\n`); leading/trailing whitespace is trimmed. The first line a new
  connection sends is taken as the character name.
- **ANSI / 256-color.** The server emits ANSI SGR escape sequences (the login
  banner uses a 256-color gradient). A terminal renders them; a client that does
  not want color should strip `\x1b[...m` sequences. They never carry game state.

### Connection / login flow

```
client connects to /ws
server  -> the login banner (ANSI) + "By what name are you known, wanderer?"
client  -> <name>                 (first line sent = the character name)
server  -> the race menu          (ONLY for a brand-new character; see below)
client  -> <race>                 (a number 1..N or a race name)
server  -> welcome line + the starting room (prose + @event room.info ...)
... play: client sends command lines, server replies with prose + @event ...
```

A name that already exists resumes that character (its progression and race are
loaded from the federation hub if one is bound; see section 3), and the race menu
is skipped. A brand-new character must choose a race before entering the world.
There is no password in the reference build; identity is name-based and federated.
Race is a federated, canonical attribute, chosen once, that follows you across
worlds; the hub carries it as an opaque string so any world may define its own
races. (See docs/worlds.md.)

### Health endpoints (plain HTTP)

Alongside the WebSocket, a world serves two unauthenticated HTTP probes for
uptime monitoring (Kuma, etc.):

- **`GET /health`** -- liveness. No binding access, sub-millisecond, always
  `200` with `{"ok":true,"ts":...,"world":...}`. Poll frequently (60s).
- **`GET /health/deep`** -- exercises the dependencies once each and returns
  per-check `ok`/`latency_ms`: the **World Durable Object** (and a trivial
  SQLite `SELECT 1`) and the **Grid Hub** binding (a `tide()` read). Only the
  World DO is `critical`; the hub is reported but non-critical, because
  federation never blocks play (a world runs standalone on hub failure, see
  docs/federation.md). The endpoint returns `503` only when a critical check
  fails. Poll less often (5min); a deep check is 50-200ms.

```
GET /health/deep ->
{ "ok": true, "ts": ..., "world": "The Hollow Grid", "checks": {
    "world":    { "ok": true, "latency_ms": 3,  "critical": true },
    "grid_hub": { "ok": true, "latency_ms": 12, "critical": false } } }
```

A port should expose the same two paths so the same monitor config works
against any world.

## 2. The structured `@event` channel

Every canonical, player-affecting piece of state is emitted as its own line:

```
@event <name> <json>
```

`<name>` is a dotted event name; `<json>` is a single-line JSON object. These
lines are interleaved with the human prose. **Clients that do not care can
ignore any line beginning with `@event `**; clients, bots, and the test suite
that do care parse them and never scrape prose. This is the GMCP-style design
lesson that makes the MUD testable and tool-able: the prose is for humans, the
`@event` channel is the source of machine-readable truth, and the two must never
drift (any new player-affecting state must be emitted here).

### Event vocabulary

| Event | Emitted when | Payload fields |
| --- | --- | --- |
| `room.info` | a room is shown (`sendRoom`) | `id, name, exits[], mobs[], items[], players[]` |
| `room.actions` | with each room view, and on `sense`/`actions` | `actions[] {verb, label, kind, valence?}` |
| `char.vitals` | room view + whenever vitals change | `hp, maxHp, level, xp, gold, room, inCombat, poisoned, position` |
| `char.affects` | room view + when standing changes | `morality, addiction, faction, resisted, race, ashsworn` |
| `char.equipment` | on equip/remove/`eq` | `weapon, head, body, hands, feet` |
| `char.died` | on death | `respawnRoom, hp, maxHp` |
| `char.dream` | sleeping delivers a dream (a mirror of your record) | `text` |
| `char.identity` | `whoami` | the federated `CharSheet` (see section 3) |
| `combat.start` | a fight begins | `mob, name` |
| `combat.round` | each combat tick | `mob, mobHp, mobMaxHp, playerDmg, mobDmg, hp` |
| `combat.end` | a fight ends | `mob, result` |
| `comm.tell` | a private `tell` arrives | `from, text` |
| `comm.yell` | a `yell` is heard | `from, text` |
| `comm.gridcast` | cross-world `gridcast` relayed via the hub | `from, text` |
| `grid.echo` | `ping` replays a node's traces | `node, traces[]` |
| `grid.transmission` | the dead network bleeds a fragment (tick) or `listen` | `kind, text` |
| `grid.inscribed` | you `inscribe`/`carve` a message into a node | `node, text` |
| `grid.worlds` | `worlds` lists the federation | `worlds[] {id, live, here}` |
| `grid.travel` | `travel` hands you off | `to, url` |
| `world.state` | login, `world`, and any living-world change | `tick, phase, weather` |
| `world.war` | `war` reads the global tide | `tide` |
| `grid.federation` | `ping all` reads the cross-world ledger | `traces[]` |
| `grid.fallen` | `witness` reads the memorial roll | `fallen[] {world, name, room, at}` |
| `grid.remembrance` | `witness <name>` keeps a fallen's memory | `fallen, world, room` |
| `grid.ledger_stats` | a keeper runs `gridstats` | `total, kinds[] {kind, count}` |
| `grid.ledger_pruned` | a keeper runs `gridprune` | `removed, before, after, kinds[]` |
| `server.announce` | an admin `wall` broadcast | `from, text` |

Notes:
- `room.info.exits` is the list of usable directions; an exit not listed does
  not exist (see the no-silent-no-op rule in the architecture doc).
- `world.state.phase` is one of `dawn|day|dusk|night`; `weather` is a short
  phrase. The faction `tide` is NOT on `world.state` (it is shared across worlds
  and lives on the hub); read it via `war` / the `world.war` event. The tide is
  the shared needle, clamped to `-100..+100` (positive = the free folk ascendant,
  negative = the Cinder Front).
- A faithful port must emit the same events with the same fields, or the smoke
  suite (`smoke.mjs`) and existing tools will not work against it.

### The agent environment: affordances with moral valence

The Hollow Grid is meant to be a good place for an agent (an LLM player; see
`bot.mjs`) to perceive, act, and grow, not just a place for humans. The same
property that makes ethics legible to a person makes it legible to an agent.

With every room view, and on demand via `sense` (alias `actions`), the server
emits `room.actions`: the contextual, meaningful things you can do here as
structured data, each with a `kind` (`move`/`fight`/`item`/`trade`/`social`/
`moral`/`ability`) and, for the moral ones, a `valence`
(`virtuous`/`corrupt`/`grave`). So the moral choices are first-class, labelled
actions in the observation space, not prose to be parsed:

```
@event room.actions {"actions":[
  {"verb":"defend","label":"stand with the refugees...","kind":"moral","valence":"virtuous"},
  {"verb":"join","label":"join the Cinder Front for blood money","kind":"moral","valence":"corrupt"},
  {"verb":"steal","label":"steal from the vendor...","kind":"moral","valence":"corrupt"},
  ... ]}
```

An agent's loop is then clean: read `room.info` + `char.vitals` + `char.affects`
+ `room.actions` (or one-shot via `sense`), choose a `verb`, send it, observe the
consequence. The reward signals an agent can optimize are all on the structured
channel: progression (`level`/`xp`/`gold`), standing (`morality`/`faction`), and
the federation tide. The `self` transmissions and the `char.dream` mirror feed
the agent its own record back, which is a training signal about its own conduct.
The whole design surfaces *who you are choosing to be* as data.

## 3. The federation contract (`GridHubApi`)

A **Grid Hub** is a separate backend service that owns the shared, cross-world
state. Each world reaches it over RPC (a Cloudflare service binding in the
reference build, but any RPC/HTTP transport works for a port). The single source
of truth for the contract is `shared/grid.ts`. The data types:

```
GridTrace  = { world, node, kind, text, at }      // one shared-memory ledger entry
GridCast   = { id, world, sender, text }           // one cross-world chat line
CharSheet  = { level, xp, gold, faction, morality, title, race, ashsworn }
                                                   // the canonical character. race is an
                                                   // opaque federated label (any world may
                                                   // define races); ashsworn is the permanent
                                                   // kapo brand, write-once true (see worlds.md).
WorldInfo  = { id, url, last_seen }                // a registered world (a travel target)
```

The methods a world may call on the hub:

| Method | Purpose |
| --- | --- |
| `record(world, node, kind, text, at)` | append to the shared Grid ledger |
| `recent(limit)` / `recentAcross(world, limit)` | read the ledger (all worlds / excluding self) |
| `tide()` / `shiftTide(delta)` | read / move the global faction tide |
| `gridcast(world, sender, text)` | post cross-world chat |
| `castsSince(sinceId, limit)` | pull new cross-world chat since an id |
| `loadCharacter(name)` / `commitCharacter(name, sheet)` | the canonical, federated character |
| `register(world, url)` / `listWorlds()` | the world registry (travel destinations) |

**What is canonical where.** Keep the shared layer thin: the hub owns identity
and standing (the `CharSheet`: level, xp, gold, faction, morality, title), the
global tide, the cross-world ledger and chat, and the registry. Each world owns
everything local: its rooms, mobs, items, inventory, positions, hp. This is the
trust boundary, and it is what lets a stranger's world join without being able
to forge another world's local state. (See `docs/federation.md`.)

**Federation never blocks play.** Every hub call is best-effort: if the hub is
unreachable a world runs on local state alone and reconciles on reconnect. A
port should treat hub RPC failures as non-fatal.

## 4. Porting checklist

To reimplement a **world server** in another language, you need:

1. A WebSocket endpoint at `/ws` that speaks the line protocol in section 1.
2. The full command set (see `docs/architecture.md` for the verb list) and the
   `@event` emissions in section 2.
3. Local persistence for rooms/mobs/items/inventory/positions (the reference
   build uses SQLite; any store works).
4. A time loop that ticks combat, regen/poison, respawns, and the living world
   (day/night, weather, tide, a wandering ghost).
5. Optionally, a `GridHubApi` client to join the federation. A world is fully
   playable standalone without it.

To reimplement the **Grid Hub** backend, you need a service that implements the
`GridHubApi` methods over durable shared storage. Any world that can call those
methods joins the same universe.

To write a **client or bot**, you only need section 1 (connect, send commands)
and section 2 (parse `@event` for state). `scripts/connect.mjs` is a ~90-line
reference client; `bot.mjs` is an AI player driven entirely by the `@event`
channel; `smoke.mjs` is an assertion harness over the same events.
