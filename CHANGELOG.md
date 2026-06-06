# Changelog

All notable changes to The Hollow Grid. Versioning is SemVer-style
`0.MINOR.PATCH` while pre-1.0: PATCH for fixes, docs, and tweaks; MINOR for new
features (a new system, command, or content set). The earliest entries are
reconstructed: versioning was adopted at v0.4.1, so v0.1.0 through v0.4.0 are
backfilled from git history rather than tagged at the time.

## v0.19.0

The redemption arc: the counterweight to the kapo's permanence. The ash-sworn
brand never lifts -- that is the world's one unforgivable thing -- but almost
everyone else who sinks into the cinders can find their way back, and when they
do, the world recognizes it. Mercy is real; some things still cannot be undone.

### Added
- **Two write-once standing transitions, checked at a single command chokepoint
  (`moralArc` in `webSocketMessage`) so no scattered morality site can drift:**
  - **stray** -- morality falls to `STRAY_FLOOR` (-20; the dais oath is -25, the
    kapo brand -40). A private mark; the shame is not broadcast.
  - **return** -- a strayed soul climbs back to `REDEEM_CEIL` (+5) and no longer
    stands with the Front. Reachable in one stroke by defecting at the
    Ashmonger's dais (the +30 turn lands a fresh oathbreaker at +5), or by
    sustained good works. They earn the title **"the Returned"** (federated, so
    it follows them across worlds), a `redemption` trace, and the event
    `grid.redemption`. The free folk meet their eyes again.
- **The kapo carve-out.** An ash-sworn character walks the same arc, but the
  brand does not lift: crossing the ceiling gives a private `penance` (not a
  federation banner) and the acknowledgment that the ash never washes off --
  never "the Returned". Good done is real and named as such; it is just not
  absolution. Both paths verified end-to-end (human -> Returned; elf/kapo ->
  penance).
- `whoami` shows where you stand on the arc (strayed / the Returned /
  ash-marked-and-good-anyway). New columns `strayed`/`redeemed` on `players`.
- Event `grid.redemption` (docs/protocol.md); six new smoke assertions
  (110 total).

## v0.18.0

The rite of remembrance: a counter to the Cinder Front's signature move, which
is erasure. The Front cages people, scrubs the elf-marks off the walls, and
teaches the living what looking up costs. `witness` is the refusal -- memory as
the cheapest resistance, and the only one the dead can still use.

### Added
- **The memorial roll** (federated). When a character falls anywhere on the
  Grid, the hub records them structurally (`recordFallen` -- world, name, room,
  time; never parsed from prose). New `GridHubApi` methods `recordFallen` /
  `recentFallen`, a `Fallen` type, and a `fallen` table on the hub.
- **`witness` / `remember` / `mourn`.** With no name it reads the roll of the
  fallen aloud (event `grid.fallen`). With a name it holds a vigil for them
  (event `grid.remembrance`): a small standing gain (+2 morality) and a single
  point toward the free folk on the tide -- *memory is resistance*. It is on
  purpose a poor bargain, bounded to **once per fallen ever** (a local
  `remembrances` table) so it can never be farmed; you do it because it is
  right, not because it is optimal. You cannot hold a vigil for yourself.
- A `witness` moral affordance (`valence: virtuous`) at the Refugee Waystation,
  so it is first-class in the agent observation space (`room.actions`), the same
  place the free folk shelter the people the Front would disappear.
- Events `grid.fallen` / `grid.remembrance` (docs/protocol.md); three new smoke
  assertions (104 total). Full death -> witness -> reward path verified
  end-to-end against a live death.

## v0.17.0

Keeper tooling to tend the shared Grid ledger, closing out the adversarial
review's last open item (ambient-noise backlog).

### Added
- **`gridstats` / `gridprune`** (keeper-only, gated by the `ADMINS` var like
  `wall`). `gridstats` reports the hub ledger's composition by kind;
  `gridprune` flushes the ambient backlog. The federate filter already keeps new
  `ghost`/`passage`/`recall` traces local, but a pre-filter backlog lingered
  because hub retention is count-based and a quiet Grid never inserts enough to
  flush it. `gridprune` clears exactly those three kinds. The purgeable set is
  **fixed in code**, so even a claimed keeper name cannot erase meaningful
  traces (oaths, deaths, kindnesses, inscriptions, quests).
- Hub RPC gains `ledgerStats()` and `pruneLedgerKinds(kinds)` (`GridHubApi`).
- New events `grid.ledger_stats` and `grid.ledger_pruned` (docs/protocol.md);
  four new smoke assertions (keeper read, prune, ambient-gone, non-keeper
  refused) -- 101 checks.

## v0.16.0

Operational visibility: the world now exposes health probes for uptime
monitoring, matching the `/health` + `/health/deep` pattern used across the
SkyPhusion fleet.

### Added
- **`GET /health`** -- a liveness probe. No binding access, sub-millisecond,
  always `200` with `{ ok, ts, world }`. Safe for high-frequency polling (Kuma
  at 60s).
- **`GET /health/deep`** -- a deep check that exercises each dependency once and
  reports per-check `ok`/`latency_ms`: the **World Durable Object** (via a
  trivial SQLite `SELECT 1` on an internal DO route) and the **Grid Hub**
  service binding (via a `tide()` read). Only the World DO is `critical`; the
  hub is reported but non-critical, because federation never blocks play, so a
  hub outage degrades cross-world features without flipping the world red. The
  endpoint returns `503` only on a critical failure. Documented in
  docs/protocol.md; covered by four new smoke assertions.

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
- **The reference agent (`bot.mjs`) now consumes the affordance layer.** The
  headline `room.actions` feature had no consumer: the bot free-formed verbs from
  a text prompt. It now stores `room.actions` and lays the enumerated, valence
  tagged verbs into the brain's context with a directive to pick from them, so
  the agent reads its action space instead of hallucinating it. (The running
  `hollowbot` on acab needs a `git pull` + restart to take effect.)
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
