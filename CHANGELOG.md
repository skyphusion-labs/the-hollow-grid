# Changelog

All notable changes to The Hollow Grid. Versioning is SemVer-style
`0.MINOR.PATCH` while pre-1.0: PATCH for fixes, docs, and tweaks; MINOR for new
features (a new system, command, or content set). The earliest entries are
reconstructed: versioning was adopted at v0.4.1, so v0.1.0 through v0.4.0 are
backfilled from git history rather than tagged at the time.

## v0.15.1

Drift-and-noise fixes from an adversarial review (another Opus played the world
as an agent off the socket and read the source). Each verified against the
running system before fixing.

### Fixes
- **The federated ledger was 100% ambient noise.** `ping all` on prod returned
  6 ghost + 2 passage traces and zero meaningful ones -- the wandering ghost and
  ordinary passage/recall were federating to the hub and burying deaths, oaths,
  kills, kindnesses, inscriptions. `recordTrace` gains a `federate` flag; ghost/
  passage/recall now stay LOCAL. Verified: the federated feed is now all
  meaningful traces. (The "cheapest magic," signal restored.)
- **The `talk` affordance drifted from the `talk` handler.** `room.actions`
  advertised `talk` in 4 rooms; the handler answered in 8 (tavern, workshop,
  holding_pit, dais were silent gaps). One source of truth now -- a `TALKABLE`
  set both the handler and the affordance read, so they cannot disagree -- plus a
  smoke guard asserting `room.actions` carries `talk` in the tavern.
- **`world.state.tide` was always 0** (the local column is never written; the
  real needle is hub-side). Removed the dead field; agents read the tide via
  `war`/`world.war`. Deleted, not cached -- caching would reintroduce the drift.
- **`commune` said "(+0 HP)" at full health.** Now reads cleanly when there is
  nothing to mend.
- **Docs:** added `grid.federation` to the protocol event table; corrected
  `char.affects` (race, ashsworn) and `world.state` (no tide) in CLAUDE.md.

## v0.15.0

The wastes answer the tide. The shared faction war, made visible in the world
itself: collective choice with collective, felt consequence.

### Code
- Once the federation-wide tide has decisively tipped (>= +40 free folk, or
  <= -40 Cinder Front), the living world shows it on the tick: signs of life
  returning when the free folk are winning (a green shoot through the concrete,
  a bird no one's heard in years, the hum sounding almost gentle), or fear
  closing in when the Front is (smoke on the horizon, eyes kept down). The
  balanced middle stays the plain wastes. `src/signs.ts`; emitted on the tick
  (`SIGN_TICKS`) as `world.sign` ({tide, mood, text}), styled dim green/red.
- The tide is on the hub; `worldTick` reads a best-effort `lastTide` cache
  (refreshed by `contributeTide` and `war`). `war` now also names what the tide
  is doing to the world ("the wastes are starting to come back to life").
- A hopeful counter-theme to the dead-network melancholy: loss is not the end
  state; life insists on returning, and returns faster where people choose well.

## v0.14.0

One good thing people can do FOR each other. The wastes are full of things done
TO each other (rob, recruit, betray); this is the counterweight.

### Code
- `mend <player>` (alias `tend`): pour some of your own strength into another
  player in your room, healing them at a cost to yourself (HP out of you, into
  them, up to 12, never dropping you below 5). A small morality gain for the
  kindness; a 30s cooldown so it stays an act, not an economy. Witnesses in the
  room see it, and the Grid records it as a `kindness` trace -- so `ping` and
  `ping all` remember the kindnesses too, not only the oaths and the kills.
  Reuses the cross-player `socketByName` pattern from `give`. Smoke at 92 checks
  (the room-targeting + already-whole guard; the real transfer verified live).

## v0.13.0

Leave a message for whoever comes next. The dead makers fill the network with
their last words (transmissions); now the new minds can too.

### Code
- `inscribe <message>` (alias `carve`/`leave`): carve your own words into the
  Grid at your current node. They are recorded as a `mark` trace -- kept in the
  node's memory and federated to the hub like any trace -- so a later `ping`
  (this node) or `ping all` (across every world) finds them, set apart as a voice
  a hand left on purpose. You will be gone; the Grid keeps you. Player text is
  sanitized hard (printable ASCII, no newlines -> no @event injection, bounded).
  Emits `grid.inscribed` ({node, text}). Emergent, federated collective memory --
  and, for agents, a way to leave traces for other agents. Smoke at 91 checks.

## v0.12.0

The agent environment: moral choice as a first-class, machine-readable
affordance. A world built so an LLM agent can perceive, act, and grow in it, and
so the ethics are legible rather than buried in prose.

### Code
- With every room view, and on demand via `sense` (alias `actions`), the server
  emits `room.actions`: the contextual things you can do here as structured data,
  each with a `kind` (move/fight/item/trade/social/moral/ability) and, for the
  moral ones, a `valence` (virtuous/corrupt/grave). The Cinder Front choices, the
  cages, the tavern's vices, the dais defection, and an elf's `join` (flagged
  grave: the kapo) are all labelled actions in the observation space.
- `sense` prints a readable menu for a human and emits the full one-shot
  observation (room.actions + vitals + affects) for an agent loop. Documented as
  the agent environment in docs/protocol.md. Smoke at 90 checks.

## v0.11.0

The network dreams you. A reckoning every time you rest.

### Code
- When you `sleep`, the dead Grid -- the one thing that remembers everything you
  have done -- holds up a mirror: a dream assembled from who you have become
  (`src/dreams.ts`, hooked in `setPosition`). The kapo dreams of the cages from
  the inside; the collaborator of the refugee who bolted; the saint of the people
  he carried; the thief of everything he took; the unaligned of a city full of
  faces he never met. Six registers, keyed off `ashsworn` / `faction` / morality
  bands. Styled in dim ANSI, emitted as `char.dream` ({text}). Rare by design (a
  90s cooldown, so it stays a reckoning, not noise). Smoke at 88 checks. This is
  the "designed to make you think" turned on the player themselves.

## v0.10.0

The dead network speaks. "The network outlived us. Now it just hums, empty, and
waits." Made literal.

### Code
- Fragments of the world-that-was bleed through the wire on the living-world tick
  (and on demand via `listen` / `tune`), across four registers (`src/transmissions.ts`):
  **signal** (systems still running their loops for no one), **ad** (the old
  world still selling, to ghosts), **human** (the last voices, the makers the
  network outlived), and **self** (the Grid noticing you by name). The ambient
  mix leans banal so the human/self ones land harder; `listen` digs toward the
  voices. Each is styled by register in dim ANSI and emitted on the structured
  channel as `grid.transmission` ({kind, text}); `self` fragments are
  personalized per listener. Smoke at 87 checks.

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
