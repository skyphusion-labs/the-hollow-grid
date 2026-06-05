# Changelog

All notable changes to The Hollow Grid. Versioning is SemVer-style
`0.MINOR.PATCH` while pre-1.0: PATCH for fixes, docs, and tweaks; MINOR for new
features (a new system, command, or content set). The earliest entries are
reconstructed: versioning was adopted at v0.4.1, so v0.1.0 through v0.4.0 are
backfilled from git history rather than tagged at the time.

## v0.4.1

Project tooling and conventions. Added a `CLAUDE.md`, adopted the SkyPhusion
house conventions shared with the author's other Cloudflare repos, and started
this changelog plus version discipline.

Why: bring the repo in line with the author's other projects and lock in the
no em/en dash rule, which the codebase was violating in 44 places.

### Code
- `CLAUDE.md` (new): architecture guide, the smoke-test workflow, and house conventions.
- `CHANGELOG.md` (new): this file.
- `package.json`: version 0.1.0 -> 0.4.1.
- `README.md`, `src/*.ts`: scrubbed all 44 em-dashes (U+2014) and en-dashes (U+2013), replaced with commas, semicolons, colons, or parentheses.
- typecheck: clean.

## v0.4.0

Morality system. A persistent morality score plus gold, surfaced as "standing"
in `status`, exposed through four independent moral situations: theft vs. honest
selling at the market; buying and using dust (a free full heal at a moral and
addiction cost); the tavern wench (`carouse`, which inflicts an affliction) vs.
`resist`; and the Cinder Front rally, where you `join` the nativist movement or
`defend` the persecuted elves (a sticky one-time choice).

Why: give choices that reveal who the character is. Standing is the sum of
independent choices, so defending the elves still reads as good even when the
character is corrupt elsewhere.

### Code
- `src/world.ts`, `src/types.ts`, `src/items.ts`, `src/rooms.ts`, `src/mobs.ts`, `README.md`.
- Shipped together with v0.3.0 in commit 9e46eec, before versioning was adopted.
- typecheck: clean; verified with a live `wrangler dev` smoke test.

## v0.3.0

Items, loot, the maiden rescue quest, and poison/antidote. Item templates with
use-effects, per-player inventory and per-room ground piles in SQLite, and loot
drops on mob death. A rad-scorpion poisons on hit (the alarm drains HP each
tick); the cure is an antidote, rewarded for rescuing the captive maiden held
behind the warden.

### Code
- `src/items.ts` (new), `src/world.ts`, `src/types.ts`, `src/mobs.ts`, `src/rooms.ts`, `README.md`.
- typecheck: clean; verified with a live `wrangler dev` smoke test.

## v0.2.0

Alarm-driven combat. A Durable Object alarm resolves combat rounds (player hits,
mob hits back), respawns slain mobs on a timer, and handles death/respawn and
XP/leveling. The alarm reschedules only while there is pending work, then lets
the DO hibernate.

### Code
- `src/mobs.ts` (new), `src/world.ts`, `src/types.ts`, `README.md`.
- typecheck: clean; verified with a live `wrangler dev` smoke test.

## v0.1.0

World DO skeleton. A single `World` Durable Object holds the game; players
connect over WebSocket, pick a name, move between linked rooms, and `say` to
others in the same room. Per-connection state rides on the hibernation
attachment; room membership is derived from `ctx.getWebSockets()`; SQLite
persists each player's room.

### Code
- Initial: `src/index.ts`, `src/world.ts`, `src/rooms.ts`, `src/types.ts`, `wrangler.jsonc`, `tsconfig.json`, `package.json`, `README.md`, `.gitignore`.
- typecheck: clean; verified with a live `wrangler dev` smoke test.
