# The Hollow Grid

A multiplayer MUD that runs entirely on [Cloudflare Workers](https://developers.cloudflare.com/workers/)
and [Durable Objects](https://developers.cloudflare.com/durable-objects/): no
VPS, no process to babysit, ~$0 when nobody is playing. It is also a small
**federation**: separate world deployments share one Grid (one faction war, one
set of characters, cross-world travel), and a "world" is just **content plus
three environment variables** on a generic engine. Theme: post-apocalyptic
cyber-decay, "the network outlived us."

Read the writeup (the story, the design decisions, and how it was built):
**[The Hollow Grid on skyphusion.net](https://skyphusion.net/blog/the-hollow-grid/)**.

## Play now

Two live worlds on one shared Grid. Open either in a browser and you are in:

- **The Hollow Grid** -- https://hollow.skyphusion.org (the dead neon city)
- **Dustfall** -- https://dustfall.skyphusion.org (the open salt pan people fled to)

Each domain serves its own in-browser terminal (xterm.js) and accepts any raw
WebSocket client at `/ws`. Make a character in one, `travel` to the other, and
your name, level, and standing come with you.

## The map

![The Hollow Grid world map](https://hollow.skyphusion.org/map.svg)

The world at a glance: the Nexus and town (cyan), the Undercity server farm
(green), the open wastes (amber), and the Cinder Front's stronghold (red), with
dashed links for the ladders and shafts. It is **generated from `src/rooms.ts`**
(the single source of truth for rooms and exits) by `npm run map`, served live at
**[hollow.skyphusion.org/map.svg](https://hollow.skyphusion.org/map.svg)**, and
committed at [`docs/map.svg`](docs/map.svg). The topology is shared across the
federation, so the same shape is Dustfall's too (it just relabels the rooms).

## What makes it interesting

- **A universe, not a server.** The engine is generic; rooms, creatures, gear,
  and the login banner are data selected per deployment by one `WORLD_MAP` key.
  The two worlds run the *same code* and feel like entirely different places.
  Adding a world is a content pack, not a fork. (`docs/worlds.md`)
- **Real cross-deployment federation.** A separate backend Worker (the Grid Hub)
  owns the shared layer: a global faction tide every world moves, one canonical
  character that follows you between worlds, a cross-world chat and memory ledger,
  and a registry you `travel` through. The trust boundary is thin and explicit.
  (`docs/federation.md`)
- **Machine-readable by design.** Alongside the prose, the server emits a
  structured `@event` channel (GMCP-style) that is the source of truth for game
  state. Clients, bots, and the test suite parse those events and never scrape
  English. (`docs/protocol.md`)
- **Zero-ops and cheap.** One Durable Object holds a world; WebSocket hibernation
  lets it sleep when idle; a single alarm drives all time. It costs about nothing
  when empty and scales itself.
- **Choices the world remembers.** A hidden morality score, a faction war over
  the persecution of refugees, drugs and theft and temptation, and consequences
  that persist. The design is about who your character is when no one is making
  you.

## Run it locally

```bash
npm install
npm run dev          # the whole federation: World A :8787 + Dustfall :8788 + a shared hub
# npm run dev:solo   # or just one world + the hub on :8787

npm run connect                              # play World A in your terminal
npm run connect -- ws://localhost:8788/ws    # play Dustfall
```

No global install needed (`scripts/connect.mjs` is dependency-free; `npx wscat`
works too). Verify changes with `npm run typecheck` then `npm run smoke` (81
end-to-end checks over the `@event` channel). See `docs/deploy.md`.

## The game

You wake in the wastes with a rusted blade and little else. Explore linked rooms,
fight things that fight back (combat resolves on a ~3s tick; death sends you to a
respawn, not a penalty spiral), scavenge and `buy`/`sell` gear, take the
core-shard quest, and decide what the wastes make of you.

The spine is moral, not mechanical. Standing (shown in `status`) is the sum of
independent choices the world keeps tempting you with:

- **Honest work vs theft** at the market: `sell` salvage for clean coin, or
  `steal` for quick gold that corrupts you.
- **Drugs** at the tavern: `buy dust` for a free, incredible full heal at the
  cost of your morality and a deepening addiction. Or never touch it.
- **The Cinder Front:** a nativist movement rallying to round up the
  "unregistered elves." `join` them for blood money and a ruined conscience, or
  `defend` the refugees and earn their gratitude. The faction tide you move is
  shared across every world on the Grid, and at the endgame you can raid the
  Front's stronghold or `defy` its commander to defect.

Nothing here is gated behind secret words; `help` lists everything. The full
command set and event vocabulary are in `docs/architecture.md` and
`docs/protocol.md`.

## Build a client, a bot, or a port

The server is just WebSocket text plus a JSON event channel, specified
language-agnostically in **`docs/protocol.md`** so it can be reimplemented in any
language. References in this repo:

- `scripts/connect.mjs` -- a ~90-line dependency-free terminal client.
- `src/webclient.ts` -- the in-browser xterm.js client served at `/`.
- `smoke.mjs` -- an assertion harness over the same events.

An AI player driven entirely by the `@event` channel lives in the separate
[`mud-bots`](https://github.com/SkyPhusion/mud-bots) repo (`hollow-grid/bot.mjs`).

Ports in Go, Rust, Python, Elixir, and friends are welcome; a world that speaks
the `GridHubApi` contract (`shared/grid.ts`) joins the same federation.

## Architecture, in one breath

```
browser / wscat / bot --wss--> World Worker (/ = play client, /ws = game)
                                  -> World Durable Object (one per world)
                                       WebSocket hibernation; SQLite; one alarm
                                       -> Grid Hub Worker (shared tide/identity/ledger/registry)
```

Full design and the five rules a port should keep: `docs/architecture.md`.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) -- the runtime model, design rules, command set, repo layout.
- [`docs/protocol.md`](docs/protocol.md) -- the wire protocol, the `@event` vocabulary, and the federation contract (for ports and clients).
- [`docs/worlds.md`](docs/worlds.md) -- authoring a world / content packs (`WORLD_MAP`).
- [`docs/federation.md`](docs/federation.md) -- the federation design and trust model.
- [`docs/deploy.md`](docs/deploy.md) -- running, deploying to Cloudflare, and the Jenkins CI/CD pipeline.
- [`CLAUDE.md`](CLAUDE.md) -- conventions and the working method for contributors.
- [`CHANGELOG.md`](CHANGELOG.md) -- version history.

## License

MIT © 2026 Conrad Rockenhaus
