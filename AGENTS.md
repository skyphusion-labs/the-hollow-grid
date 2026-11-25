# The Hollow Grid

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

The Hollow Grid is a text MUD. It runs on Cloudflare Workers and Durable Objects. Players connect over WebSocket at `/ws`. They play with plain-text commands. Any raw WebSocket client can play. This repo ships a browser terminal at `/` and a command-line client via `npm run connect`.

A world is content on a generic engine. `WORLD_MAP` selects that content. Separate deployments share one Grid Hub. This repo deploys [hollow.skyphusion.org](https://hollow.skyphusion.org) and [dustfall.skyphusion.org](https://dustfall.skyphusion.org). See the [public world list](README.md#play-now) for the sibling deployments.

[docs/protocol.md](docs/protocol.md) is the wire contract. Ports and bots build to it. They do not invent a parallel protocol. Check player-facing behavior on the live worlds. Also check it on local `wrangler dev`.

## Documentation map

Deep docs live in `docs/`. Update the matching doc when your change touches that area.

- [docs/architecture.md](docs/architecture.md) covers the runtime, the design rules, and the command set.
- [docs/protocol.md](docs/protocol.md) covers the wire protocol, the `@event` vocabulary, and `GridHubApi`.
- [docs/worlds.md](docs/worlds.md) covers world authoring, `WORLD_MAP`, and shared anchor ids.
- [docs/federation.md](docs/federation.md) covers federation design and the trust model.
- [docs/deploy.md](docs/deploy.md) covers the Workers, env vars, npm scripts, and CI.

The repo implements closed federation with per-world keys and leases. Open admission for third parties is design-only. See section 10 of [docs/federation.md](docs/federation.md) and [docs/federation-open-admission.md](docs/federation-open-admission.md).

## Commands

```bash
npm install
npm run dev         # primary world :8787, Dustfall :8788, one shared hub
npm run dev:solo    # primary world plus hub on :8787
npm run typecheck   # tsc --noEmit; the CI gate
npm run smoke       # live smoke (smoke.mjs)
npm run connect     # play the primary world
npm run deploy      # hub, then primary world, then Dustfall
```

`npm run dev` starts two `wrangler dev` processes. Both bind one `grid-hub` through the local dev registry. See [scripts/dev.sh](scripts/dev.sh) and [docs/federation.md](docs/federation.md).

Play Dustfall with `npm run connect -- ws://localhost:8788/ws`. The client is [scripts/connect.mjs](scripts/connect.mjs). `npx wscat -c ws://localhost:8787/ws` also works.

## How to verify

Run `npm run typecheck` first. Then run `npm run smoke`. Smoke is the primary product gate. It drives a live `wrangler dev` over WebSocket. Vitest files in `src/*.test.ts` do not replace smoke. CI runs both in [.github/workflows/ci.yml](.github/workflows/ci.yml).

Combat and poison resolve on a tick of about 3 seconds. Wait across rounds. Delete `.wrangler/` when the schema changes. Also delete it when you need a clean SQLite state. Log in with a unique random name. A test must not reuse a saved character.

Assert on `@event` fields. Do not grep English prose. [smoke.mjs](smoke.mjs) is the worked example.

## Architecture

One Durable Object holds the whole game. `src/index.ts` routes `/ws` to `env.WORLD.getByName("world")`. Every player shares that `World` in `src/world.ts`. That shape fits up to a few hundred players. The code does not shard by zone.

Keep connection state on the socket. The Durable Object uses the WebSocket Hibernation API. Store `Session` from `src/types.ts` with `ws.serializeAttachment()`. Read it with `deserializeAttachment()`. Do not cache player state in class fields. Hibernation drops those fields. Scan `this.ctx.getWebSockets()` to see who is online.

One alarm drives time. Each tick respawns due mobs. It drains HP from poisoned players. It resolves one combat round per fight. It advances the living world in `worldTick()`. The alarm beats every `ROUND_MS` while any player is online. `scheduleNextTick()` calls `deleteAlarm()` only after the last player leaves. `login` starts the heartbeat. Extend `alarm()` when you add a timed effect. Otherwise that effect stops.

The constructor opens SQLite inside `blockConcurrencyWhile()`. Durable tables are `players`, `mobs`, `inventory`, `ground`, `world`. `persistPlayer()` writes vitals, gold, morality. The live socket attachment mirrors those fields. A schema change uses a guarded `ALTER TABLE ADD COLUMN` loop. Follow that pattern.

The `@event` channel is machine-readable truth. `event()` in `src/world.ts` writes lines of the form `@event <name> <json>`. `sendRoom()` sends the room prose. It also emits `room.info`, `char.vitals`, `char.affects`. The `event()` calls in `src/world.ts` are the event inventory. [docs/protocol.md](docs/protocol.md) is the spec. Put canonical player state in a structured event. Prose alone is not enough. When you add state a client needs, emit the event. Then add a smoke assertion. A client may ignore a line that starts with `@event`.

Game content is data. Edit the data files. Do not fork the engine for a new room or item.

- `src/rooms.ts` holds rooms and exits. An exit works only when this file declares it. An undeclared direction returns a clear message.
- `src/mobs.ts` holds mob templates.
- `src/items.ts` holds item templates.

Poison and the tavern pox share one mechanic. The mechanic is the `poisoned` flag, the alarm HP drain, the antidote. Reuse it for a new affliction.

`webSocketMessage` calls `handleLogin` when the player has no name. Otherwise it calls `handleCommand`. Output is plain text. `line()` wraps a message in CRLF. `prompt()` sends `> `.

## Conventions

Use TypeScript, ESM, strict mode. Export the Durable Object class from `src/index.ts`. Bind it as `WORLD` in `wrangler.jsonc` with a `new_sqlite_classes` migration. Output uses `\r\n` (`NL`).

Do not use an em dash (U+2014) or an en dash (U+2013) in source, comments, docs, or in-game text. Use a comma, parentheses, or two hyphens (`--`).

Keep runtime dependencies small. There is no framework. Typecheck is the compile step. Justify a new runtime dependency.

Mirror every `wrangler.jsonc` binding in the hand-authored `Env` interface in `src/types.ts`. Take runtime types from the pinned `@cloudflare/workers-types` devDependency. Do not generate `worker-configuration.d.ts`. Git ignores that file.

`npm run typecheck` must pass before you push.

## Docs

Write Simplified Technical English. Use short sentences. Put one idea in each sentence. Use the active present tense. Use plain words. Use the same word every time.

State the limit next to the capability. Do not turn a measured result into a promise. A failed smoke run is a result. Keep the record.

## Commits and version

Use one scoped commit for one change. The subject names the change. The body says why.

A version moves only in a release pull request. Bump `package.json` in that pull request. Then add the `CHANGELOG.md` entry. A feature pull request does not bump the version. A fix pull request does not bump the version. See `package.json` for the current version. Do not copy that number into a second file as a permanent pin.

The tag form is `v*`. Put the tag on the merge commit of the release pull request.

Before a release pull request, look for a tag of the current version. A matching tag means the cycle is closed. The release pull request then bumps. No matching tag means a bump already landed outside a release pull request. Stop and read why.

While the project is pre-1.0, use `0.MINOR.PATCH`. PATCH covers a fix or a backend tweak. MINOR covers a new system, command, or content set.

A release commit ends the subject with the version in parentheses. Example: `feat(combat): mob aggro (v0.4.0)`. Add a `CHANGELOG.md` entry at the top of the file. Include a `### Code` section. Name the files you touched. Name the typecheck result.

## Release

Cut the release on `main` through a pull request. Merge it. Then tag that merge commit.

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The `deploy` job in [.github/workflows/ci.yml](.github/workflows/ci.yml) runs only on a pushed `v*` tag. A merge to `main` runs CI. It does not deploy. The tag job refuses a tag that is not on `origin/main`. See [docs/deploy.md](docs/deploy.md).

Play the live worlds after that deploy job is green. A green check is not play.

## Safety

Do not put a secret in a tracked file. Do not put a secret in a log. Do not put a secret in a test trace. Do not put a secret in an issue.
