# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A text MUD ("The Hollow Grid") that runs entirely on Cloudflare Workers + Durable Objects. Players connect over WebSocket (`wss://.../ws`) and play with plain-text commands, so a raw client like `wscat` works as the game client.

## Commands

```bash
npm install
npm run dev         # wrangler dev: local server on http://localhost:8787 (DO + SQLite run locally)
npm run typecheck   # tsc --noEmit: the CI gate; run before pushing (no other compile step)
npm run deploy      # wrangler deploy
```

Connect locally with `wscat -c ws://localhost:8787/ws`.

### Verifying changes (this is the project's test method)

There is no unit-test suite. Features are verified end-to-end against a live `wrangler dev` with a scripted WebSocket client. Node 24+ has a global `WebSocket`, so a smoke test is a plain `.mjs` script: open one or more sockets, send command lines with small delays (combat and poison resolve on a ~3s alarm tick, so wait several seconds across rounds), then assert on server output. Always run `npm run typecheck` first, then the live smoke test (`npm run smoke`, which runs `smoke.mjs`), before considering a change done. Wipe `.wrangler/` to reset local game state (SQLite) when the schema changes or a clean run is needed; and have tests log in with a unique random name so they never inherit a persisted character's position.

**Prefer asserting on the structured `@event` channel, not prose.** The server emits machine-readable state lines (`@event room.info {...}`, `@event char.vitals {...}`) alongside the human text (see "the structured state channel" below). A smoke test should parse those and assert on exact fields (room id, exits, hp/maxHp, inCombat) rather than grepping English, which is brittle. `smoke.mjs` is the worked example.

## Architecture

**One global Durable Object holds the entire game.** `src/index.ts` (the Worker) routes `/ws` upgrades to a single DO instance via `env.WORLD.getByName("world")`; everyone shares that one `World` instance (`src/world.ts`), which is what makes the world coordinated. This is deliberate and fine for up to a few hundred players. Scaling further means sharding by zone (one DO per area) plus cross-DO messaging, which the current code does NOT do.

**Connection state lives on the socket, not in instance fields.** Connections use the WebSocket Hibernation API (`ctx.acceptWebSocket`, the `webSocketMessage` / `webSocketClose` handlers). The DO can be evicted from memory while sockets stay open, so per-player state (`Session` in `src/types.ts`: name, room, vitals, target, gold, morality, faction, and so on) is stored on each socket via `ws.serializeAttachment()` and read back with `deserializeAttachment()`. Never cache player or connection state in plain class fields; it will not survive hibernation. "Who is online / who is in room X" is always derived by scanning `this.ctx.getWebSockets()` and reading attachments (see `sessions()`, `playersInRoom()`, `broadcast()`).

**A single DO alarm drives all time-based mechanics.** `alarm()` each tick: (1) respawns due mobs, (2) drains HP from poisoned/afflicted players, (3) resolves one combat round per active fight. After running, `scheduleNextTick()` reschedules the alarm only if something is still pending (an active `target`, a `poisoned` player, or a dead mob awaiting respawn); otherwise it calls `deleteAlarm()` so the DO can hibernate. Any code path that starts combat or applies an affliction must ensure the alarm is running (for example `attack()` and `carouse()` await `scheduleNextTick()`). When adding a new timed effect, extend both the `alarm()` body and the "busy?" check in `scheduleNextTick()`, or it will silently stop ticking.

**Persistence is SQLite, set up in the constructor.** `blockConcurrencyWhile()` creates tables and seeds mob instances (one row per template). Durable state: `players`, `mobs`, `inventory` (per-player), `ground` (per-room item piles). Player vitals/gold/morality are written through `persistPlayer()` and mirrored on the live socket attachment. Schema changes use a guarded `ALTER TABLE ADD COLUMN` loop wrapped in try/catch so existing local DBs upgrade in place; follow that pattern instead of bumping migrations during early development.

**The structured state channel (GMCP-style) is the source of machine-readable truth.** Alongside prose, the DO emits events as their own lines, `@event <name> <json>` (helper: `event()` in `src/world.ts`). `sendRoom()` is the single way a room is shown: it sends the prose AND emits `room.info` ({id, name, exits, mobs, items, players}) + `char.vitals` ({hp, maxHp, level, xp, gold, room, inCombat, poisoned}) + `char.affects` ({morality, addiction, faction, resisted}). The current event vocabulary: `room.info`, `char.vitals`, `char.affects`, `char.died` ({respawnRoom, hp, maxHp}), and combat: `combat.start` ({mob, name}), `combat.round` ({mob, mobHp, mobMaxHp, playerDmg, mobDmg, hp}), `combat.end` ({mob, result}). `emitVitals()`/`emitAffects()` also fire wherever the underlying state changes off a room view (combat rounds, poison ticks, dust use, faction/resist choices). RULE: any canonical, player-affecting state belongs in a structured event, never prose-only -- the two channels drifting apart is what makes a MUD un-testable and un-tool-able. When you add state a client/bot/test would need (a new vital, a quest flag, an affect), emit it here, and add a smoke assertion. Clients that don't care can ignore lines starting with `@event`.

**Game content is data, the engine is generic.** Add content by editing the data files, not the engine:
- `src/rooms.ts`: rooms and their `exits`. An exit only works if it is declared here; undeclared directions return a clear message (this no-silent-no-op rule is intentional, since a phantom unusable exit was the bug that motivated the whole project). Also exports location constants (`HOLDING_PIT`, `TAVERN`, `MARKET`, and others) used for room-specific interactions.
- `src/mobs.ts`: mob templates with stats, `loot` tables, `poisonChance`, respawn timing.
- `src/items.ts`: item templates with `use` effects (`cure_poison` / `heal` / `drug`) and sell `value`.

**Affliction model:** poison and the tavern "pox" share one mechanic, the `poisoned` flag plus the alarm's HP-drain plus the antidote cure. Reuse it for new afflictions rather than adding a parallel system.

**Command flow:** `webSocketMessage` goes to `handleLogin` if the player is unnamed (first line = name, loads/creates the player), otherwise to `handleCommand`, which parses `verb + args`, handling directions first (movement) then a `switch`. Output is plain text; `line()` wraps a message in CRLFs and `prompt()` sends `> `. Room-specific actions (the maiden quest, theft, the Cinder Front, tavern vices) gate on the player's current `room` matching a location constant.

## Conventions specific to this repo

- TypeScript, ESM, strict mode. The DO class is exported from `src/index.ts` (required) and bound as `WORLD` in `wrangler.jsonc` with a `new_sqlite_classes` migration.
- Output uses `\r\n` (`NL`) for clean rendering in line-based clients.

## SkyPhusion house conventions (shared across the author's Cloudflare repos)

These come from the sibling `skyphusion-llm-public` repo and apply here too:

- **No em-dashes (U+2014) or en-dashes (U+2013) anywhere in source, comments, docs, or in-game text.** Use commas, semicolons, or parentheses. (This rule names the codepoints rather than printing the glyphs, on purpose.)
- **Handle/username is `skyphusion`** across all services. Default to it when a username is needed.
- **Minimal runtime deps, no framework, no build step beyond TypeScript.** New runtime dependencies need justification.
- **Mirror every `wrangler.jsonc` binding in the hand-authored `Env` interface** (here in `src/types.ts`). Runtime types come from the pinned `@cloudflare/workers-types` devDep; do not generate `worker-configuration.d.ts` (it is gitignored).
- `npm run typecheck` is the gate; it must pass before pushing.

### Commits & release versioning

- One scoped commit per change: subject is the scoped change, body is the why, footer lists files touched. Commit messages end with the `Co-Authored-By: Claude` trailer.
- SemVer-style `0.MINOR.PATCH` while pre-1.0: PATCH for fixes/backend tweaks, MINOR for new features (a new system, command, or content set). Bump `package.json` `version` in the same commit.
- A commit that ships a release ends its subject with the version in parens, e.g. `feat(combat): mob aggro (v0.4.0)`, and adds a top-of-file `CHANGELOG.md` entry (heading, one-line summary, the why, and a `### Code` section listing files touched and typecheck status). This repo has not started release discipline yet; adopt it when it does.
