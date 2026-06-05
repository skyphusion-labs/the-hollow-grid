# Changelog

All notable changes to The Hollow Grid. Versioning is SemVer-style
`0.MINOR.PATCH` while pre-1.0: PATCH for fixes, docs, and tweaks; MINOR for new
features (a new system, command, or content set). The earliest entries are
reconstructed: versioning was adopted at v0.4.1, so v0.1.0 through v0.4.0 are
backfilled from git history rather than tagged at the time.

## v0.9.0

A signature active ability for each race, so a race is something you DO, not just
something you are.

### Code
- Seven cooldown-gated abilities (use the named verb, or the generic `ability` /
  `trait`): Human **Requisition** (the registry pays its own: gold), Elf
  **Vanish** (break off any fight and disappear), Revenant **Commune** (read the
  dead Grid's cross-world memory and draw a little of its life), Ghoul
  **Regenerate** (a heavy self-heal), Chromed **Overclock** (vent past every
  safety for one devastating strike), Dustkin **Forage** (scavenge the open
  wastes; outdoors only), Vatborn **Fabricate** (print a field stim). Defined in
  `src/races.ts`; resolved in `useTrait` (`src/world.ts`).
- Conditions that block firing (Overclock with no target, Forage indoors) do not
  spend the cooldown. The ability is named in `whoami` and `help`. Smoke at 86
  checks (ability fires + respects cooldown).

## v0.8.0

Races and character creation, with the heart of the game made playable: you no
longer watch the Cinder Front's persecution as a bystander, you choose where you
stand in it.

Why: The Hollow Grid is, at its core, about who counts as a person. Letting you
BE one of the hunted turns the theme from something you observe into something
you are.

### Code
- **Character creation gains a race step:** name -> race -> spawn. Seven races
  (Human, Elf, Revenant, Ghoul, Chromed, Dustkin, Vatborn) in `src/races.ts`,
  each defined more by its **Cinder Front stance** (accepted / tolerated /
  hunted) than by stats. Mechanical leans are light (hp/damage/armor/regen,
  Revenant poison immunity).
- **Race is a federated, canonical attribute:** it lives on the `CharSheet`
  (`shared/grid.ts`) and follows you across worlds. The hub carries the race id
  as an opaque string and never gatekeeps it, so any world (including a third
  party) can define its own races; an unrecognized race degrades gracefully.
- **The faction-reactive rooms now read your race's stance** as well as your
  faction: hunted races meet hostility at the Front's checkpoint and welcome at
  the refugee camp; the market recruiter's rhetoric turns on you by name.
- **The kapo:** an elf who joins the Cinder Front is branded `ashsworn`, a
  permanent mark (write-once true at the hub; never clears, even on defection).
  Heaviest morality cost on the board; the Front uses him with contempt, the free
  folk recoil, and the public brand reads "ash-sworn" above any faction.
- `race` and `ashsworn` surface on the `char.affects` and `char.identity` events
  and in `whoami`. Smoke suite extended (race step threaded through every login,
  plus a kapo phase): 84 checks, green. Players/characters tables and the hub
  schema migrate in place.

## v0.7.0

The federation made real, and shipped. Went from a single world to a live,
multi-world universe on one shared Grid, playable in a browser, deploying itself.

Why: prove cross-deployment federation end to end (not seeded stubs), turn "a
world" into a content pack on a generic engine, and put it on the public internet
with CI/CD so it can be announced, talked about, and ported to other languages.

### Federation: a second, real world
- `WORLD_NAME` is now per-deployment (`this.worldName`); a second world,
  **Dustfall** (`worlds/dustfall.jsonc`), runs the same code under its own
  name/url/Durable Object, binding the same Grid Hub. Proven across a real
  deployment boundary: one character spans both worlds, the global tide is one
  needle, the registry lists both live, and `travel` hands off the real address.

### Content packs (the moddability seam)
- Rooms, mobs, items, the login banner, the shop stock, the starter weapon, and
  the welcome are all per-world data selected by `WORLD_MAP`
  (`mapFor`/`mobsFor`/`waresFor`/`starterFor`/`bannerFor`/`introFor`). A world is
  now content plus three env vars, not a fork of the engine. Dustfall is the
  worked example: the open salt pan, its own creatures and salvage, a rust-and
  sand banner. See `docs/worlds.md`.

### Player-facing
- An ANSI 256-color login banner per world (`src/banner.ts`): a cyan gradient
  "HOLLOW GRID" going hollow; a rust-and-sand "DUSTFALL".
- An in-browser play client (`src/webclient.ts`) served from each world's root:
  an xterm.js terminal that connects to `/ws`, renders ANSI, and hides the
  `@event` channel. Just open the world's domain.
- A dependency-free terminal client, `scripts/connect.mjs` (`npm run connect`).

### Live, with CI/CD
- Deployed to Cloudflare on `skyphusion.org`: `the-hollow-grid` ->
  hollow.skyphusion.org, `dustfall` -> dustfall.skyphusion.org (custom domains,
  auto DNS + cert), `grid-hub` internal. `WORLD_URL` carries the prod address;
  dev overrides to localhost.
- A Jenkins pipeline (`Jenkinsfile`): install, typecheck, smoke (81 checks
  against a real local federation), and deploy on `main`. Push-to-deploy via the
  GitHub webhook. The smoke teardown runs each world under its own process group
  (`setsid` + group kill), never a process-group-wide `kill 0` (which once
  SIGTERM'd the Jenkins controller). See `docs/deploy.md`.

### Documentation
- A full docs set for announcing and porting: `docs/protocol.md` (the
  language-agnostic wire + `@event` + federation contract), `docs/architecture.md`,
  `docs/worlds.md`, `docs/deploy.md`; README overhauled; `docs/federation.md`
  marked live; this changelog caught up.

### Hardening
- The global-tide smoke check now proves exact movement instead of accepting
  "already maxed." Smoke suite at 81 checks. typecheck clean.

## v0.6.0

World registry, travel, and the Grid Hub as its own backend. (Reconstructed from
git history.)

### Code
- **Federation phase 4:** a world registry on the hub and cross-Grid `travel`
  (`register`/`listWorlds`; `travel <world>` checkpoints identity and hands off
  the destination address).
- **Grid Hub extracted into its own backend Worker** (`grid-hub/`): the hub moved
  from an in-Worker Durable Object to a separate deployment reached over an RPC
  service binding (`env.GRID`, typed by `shared/grid.ts`). This is the move that
  lets genuinely separate deployments share one Grid.

## v0.5.0

Federation foundation and an AI player. (Reconstructed from git history.)

### Code
- **Federation phases 1-3:** the shared Grid ledger (cross-world memory via
  `record`/`recent`), cross-world chat plus the global faction tide
  (`gridcast`/`tide`/`shiftTide`), and shared canonical identity
  (`loadCharacter`/`commitCharacter`, the character that follows you).
- **`bot.mjs`:** an AI player driven entirely by the `@event` channel, with
  swappable brains (local ollama by default, plus Anthropic and a Cloudflare AI
  Gateway option).

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
