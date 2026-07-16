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

Three live worlds on one shared Grid. Open any in a browser or connect with a raw
WebSocket client at `/ws`. Make a character in one, `travel` to another, and your
name, level, and standing come with you.

| World | URL | Engine |
| --- | --- | --- |
| **The Hollow Grid** (dead neon city) | https://hollow.skyphusion.org | Cloudflare Workers |
| **Dustfall** (open salt pan) | https://dustfall.skyphusion.org | Cloudflare Workers |
| **Rust Choir** (memory / archivist node) | https://rustchoir.skyphusion.org | Go fleet container ([hollow-grid-go](https://github.com/SkyPhusion/hollow-grid-go)) |

Each domain serves its own in-browser terminal (xterm.js on the TS worlds; Rust
Choir is WebSocket-only today) and accepts any raw WebSocket client at `/ws`.

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
works too). Verify changes with `npm run typecheck` then `npm run smoke` (**135
end-to-end checks** over the `@event` channel). See `docs/deploy.md`.

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
[`mud-bots`](https://github.com/SkyPhusion/mud-bots) repo (`hollow-grid/bot.mjs`,
GHCR `mud-bots-hg`). As of 2026-07-09 the fleet runs **11 LLM bots** (3 hollow +
3 dustfall + 5 rustchoir) for load soak; layout in
`fleet-chezmoi/system/stacks/biafra/mud-bots/README.md`.

Ports in Go, Rust, Python, Elixir, and friends are welcome; **Rust Choir** (Go) is
the first non-TS world on the live Grid. Any world that speaks the `GridHubApi`
contract (`shared/grid.ts`) can join the same federation.

## Architecture, in one breath

```
browser / wscat / bot --wss--> World Worker (/ = play client, /ws = game)
                                  -> World Durable Object (one per world)
                                       WebSocket hibernation; SQLite; one alarm
                                       -> Grid Hub Worker (shared tide/identity/ledger/registry)
```

Full design and the five rules a port should keep: `docs/architecture.md`.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) -- the runtime model, design rules, command set, repo layout, ports.
- [`docs/protocol.md`](docs/protocol.md) -- the wire protocol, the `@event` vocabulary, and the federation contract (for ports and clients).
- [`docs/worlds.md`](docs/worlds.md) -- authoring a world / content packs (`WORLD_MAP`) or joining via a port.
- [`docs/federation.md`](docs/federation.md) -- the federation design and trust model (three live worlds).
- [`docs/federation-open-admission.md`](docs/federation-open-admission.md) -- open-admission + hub authority design (not yet built; #62).
- [`docs/deploy.md`](docs/deploy.md) -- Cloudflare Workers deploy, Rust Choir (Go fleet), CI/CD, health probes.
- [`CLAUDE.md`](CLAUDE.md) -- conventions and the working method for contributors.
- [`CHANGELOG.md`](CHANGELOG.md) -- version history.

Related (outside this repo):

- [`hollow-grid-go`](https://github.com/SkyPhusion/hollow-grid-go) -- Rust Choir Go world server.
- [`mud-bots`](https://github.com/SkyPhusion/mud-bots) -- LLM agents and load soak (`hollow-grid/bot.mjs`).

## Who this is for

Game developers, MUD authors, and agent builders who want a persistent multiplayer text world on Cloudflare's free tier, with optional federation and AI inhabitants.

## Links

- **Play now:** [hollow.skyphusion.org](https://hollow.skyphusion.org) · [dustfall.skyphusion.org](https://dustfall.skyphusion.org)
- **Writeup:** [The Hollow Grid on skyphusion.net](https://skyphusion.net/blog/the-hollow-grid/)
- **AI players:** [mud-bots](https://github.com/skyphusion-labs/mud-bots)
- **Go port:** [hollow-grid-go](https://github.com/skyphusion-labs/hollow-grid-go)
- **Skyphusion Labs:** https://skyphusion.org · **Org:** https://github.com/skyphusion-labs

## License

[AGPL-3.0-only](LICENSE) (C) 2026 Conrad Rockenhaus. Run a modified version as a network service and the AGPL has you offer users the corresponding source. Releases tagged before this 2026 relicense remain available under the MIT license they were published under.

## Hosted worlds: privacy and acceptable use

The Hollow Grid is self-hosted software; run your own world and you are the operator (see License).
Separately, Skyphusion Labs operates the public worlds at **hollow.skyphusion.org** and
**dustfall.skyphusion.org** under their own instance notices:
[privacy](docs/legal/INSTANCE-PRIVACY.md) (we do not retain your data; your character record is
erasable) and [acceptable use](docs/legal/INSTANCE-ACCEPTABLE-USE.md) (good-faith play, no wallet
abuse). These bind players on the hosted worlds only, not self-hosters.
