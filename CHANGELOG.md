## v0.30.18

- fix(grid-hub): reject oversized character names at RPC boundary instead of truncating (prevents prefix collision) (#984 K3 wave 17).

## v0.30.17

- fix(grid-hub): tighten commit delta caps to +500 gold/xp and +1 level per commit (#984 K3 wave 16).
- fix(grid-hub): reduce commit rate window to 10/min per character (#984 K3 wave 16).
- fix(world): cache full `/health/deep` response for 30s including World DO probe (#984 K3 wave 16).

## v0.30.16

- fix(grid-hub): pin `home_world` at authenticated `claimCharacterLease` so lease-expiry races cannot cross-world takeover (#984 K3 wave 15).
- fix(grid-hub): ignore caller-supplied ledger/presence/memorial `at`; hub stamps `Date.now()` server-side (#984 K3 wave 15).
- fix(grid-hub): rolling commit rate window (20/min per character) blocks repeated gold/XP minting (#984 K3 wave 15).
- fix(grid-hub): clamp `presence(maxAgeMs)` minimum to 60s so zero cannot wipe roster (#984 K3 wave 15).
- fix(world): cache `/health/deep` grid-hub probe for 30s to limit DO wake amplification (#984 K3 wave 15).

## v0.30.15

- fix(grid-hub): enforce world key auth on binding-path `loadCharacter` and `presence` reads when `GRID_WORLD_KEYS` configured (#984 K3 wave 14).
- fix(grid-hub): require registered world on `record`, `gridcast`, `shiftTide`, `recordFallen`, and `recordRescued` mutators (#984 K3 wave 14).
- fix(grid-hub): clamp hub RPC string fields (name/world/kind) at HTTP ingress and DO boundary (#984 K3 wave 14).
- fix(grid-hub): length-independent constant-time compare for bearer and world keys (#984 K3 wave 14).
- fix(grid-hub): sanitize ledger `kind` at insert (#984 K3 wave 14).

## v0.30.14

- fix(grid-hub): character lease TTL (30m) and legacy lease_at=0 expiry so crash/disconnect cannot lock names forever (#984 K3 wave 13).
- fix(grid-hub): `claimCharacterLease` no longer sets `home_world` on first RPC; home assigned on first authenticated `commitCharacter` (blocks cross-world name squat) (#984 K3 wave 13).
- fix(webclient): Subresource Integrity pins for xterm.js CDN assets (#984 K3 wave 13).
- docs(grid-hub): triage hub auth-disabled-without-keys as dev-only; prod keys on fc#1007 (#984 K3 wave 13).
- fix(scripts): `ci-qa.sh` trap kills background wranglers on exit (#984 K3 wave 13).

## v0.30.13

- fix(grid-hub): reject non-finite `shiftTide` delta (NaN no longer poisons faction tide) (#984 K3 wave 12).
- fix(grid-hub): `commitCharacter` ignores NaN level/xp/gold/morality from attacker JSON (#984 K3 wave 12).

## v0.30.12

- fix(world): sanitize player names in transmission `{name}` substitution (#984 K3 wave 11).
- refactor: move `sanitizePlayerText` to `shared/` for hub + world reuse.
- fix(scripts): render-map imports `rooms.ts` via Node strip-types instead of `eval()` (#984 K3 wave 11).

## v0.30.11

- fix(grid-hub): generic RPC error responses (no internal lease/world leakage) (#984 K3 wave 10).
- fix(grid-hub): require world key on `loadCharacter`/`presence` reads when keys configured.
- fix(grid-hub): sanitize presence name/regard and memorial/rescued roll fields.

## v0.30.10

- fix(grid-hub): fail closed when `GRID_RPC_TOKEN` is set without `GRID_WORLD_KEYS` (#984 K3 wave 9).
- fix(grid-hub): clamp `shiftTide` delta to ±10 per call; cap `reportPresence` at 256 entries.
- fix(grid-hub): constant-time RPC bearer compare; `ws://` register URLs limited to localhost.
- fix(webclient): escape `WORLD_NAME` in served HTML.

## v0.30.9

- fix(grid-hub): `releaseCharacterLease` on disconnect so dead worlds do not lock characters forever (#984 K3 wave 8).
- fix(grid-hub): sanitize gridcast sender/text at the hub.
- ci: split coverage upload job so fork PRs run tests with `contents: read` only.

## v0.30.8

- fix(grid-hub): sanitize federated character/presence titles (strip ANSI and control bytes) (#984 K3 wave 7).
- fix(grid-hub): block legacy characters with empty `home_world`; migrate lease→home on boot (#984 K3 wave 7).
- fix(grid-hub): refuse live world URL re-point over register when `GRID_WORLD_KEYS` is unset (#984 K3 wave 7).
- fix(grid-hub): read `GRID_WORLD_KEYS` from env on each auth check (key rotation without redeploy).

## v0.30.7

- fix(grid-hub): require per-world key auth on service-binding mutators (`record`, `shiftTide`, `gridcast`, `record*`, `pruneLedgerKinds`) (#984 K3 wave 6).
- fix(grid-hub): validate `register()` URLs to `ws:` / `wss:` only (blocks registry poisoning).
- fix(grid-hub): `loadCharacter` is read-only; row creation requires authenticated `claimCharacterLease`; `commitCharacter` requires existing lease row.

## v0.30.6

- fix(grid-hub): require per-world key auth on HTTP `/rpc` mutations (`shiftTide`, `gridcast`, `record*`, `pruneLedgerKinds`) (#984 K3 wave 5).
- fix(grid-hub): invalid `GRID_WORLD_KEYS` JSON fails closed instead of disabling auth.

## v0.30.5

- fix(auth): constant-time `verifyAdminToken` compare so keeper login fails closed (#984 K3).
- fix(grid-hub): restrict `pruneLedgerKinds` to ambient kinds only; empty lease requires home world match (#984 K3).

## v0.30.4

### Security (K3 re-pass #90, #91)

- `claimCharacterLease` uses assert path (no cross-world lease overwrite hijack).
- Per-commit XP delta capped (`MAX_XP_DELTA`, same class as gold cap).

## v0.30.3

### Security (K3 audit #86)

- Grid Hub: per-world key auth on mutating RPC (`GRID_WORLD_KEYS` / `GRID_WORLD_KEY`).
- Character commit lease: only the world that claimed the lease at login may `commitCharacter`.
- Presence writes require authenticated world identity; unknown worlds rejected.
- Gold delta cap tightened to 10,000 per commit (was 1,000,000).

## v0.30.2

### Security (K3 audit #85)

- Bcrypt secret-phrase login; legacy characters migrate on next login.
- Keeper names require `ADMIN_TOKEN` at login (keeper commands gated on `keeperAuthed`).
- Hub identity merge restored on login so federation resume works across worlds.

## v0.30.1

Release sync bump (2026-07-21). No functional changes in this tag.

# Changelog

All notable changes to The Hollow Grid. Versioning is SemVer-style
`0.MINOR.PATCH` while pre-1.0: PATCH for fixes, docs, and tweaks; MINOR for new
features (a new system, command, or content set). The earliest entries are
reconstructed: versioning was adopted at v0.4.1, so v0.1.0 through v0.4.0 are
backfilled from git history rather than tagged at the time.

## v0.30.0

Found live by the Sonnet-resident bot experiment (mud-bots#39): character
creation's race menu existed only in prose, so machine players parsed wording
and fell back to random picks, dice, not choices, on any port with its own
voice. The ruling (#63): divergent prose over a convergent protocol; a world's
menu wording stays its own, the offered options become machine-readable.

### Added
- **`char.create` event.** The creation race menu (and every re-show after an
  invalid answer) now also emits `@event char.create {"races": [display names],
  "prompt": "race"}`. Prose is unspecified by design; the event is the contract.
- **Conformance assertion.** `smoke.mjs` asserts creation emits `char.create`
  with a non-empty races list, making machine-readable creation a federation
  conformance requirement while phrasing never is.

### Code
- `src/world.ts`: `sendRacePrompt()` emits `char.create`.
- `docs/protocol.md`: login-flow diagram + event vocabulary + the prose-vs-
  options rule; `CLAUDE.md` vocabulary list updated.
- `smoke.mjs`: the two creation-channel checks. Typecheck clean.

## v0.29.9

Found by mud-bot load testing on hollow and dustfall (combat-stuck JSONL: fights
never resolving after 120s, especially under federation hub traffic).

### Fixed
- **Alarm always reschedules.** `alarm()` now calls `scheduleNextTick()` in a
  `finally` block so a thrown tick or a slow federation poll cannot freeze combat
  rounds while `target` stays set (`inCombat: true` forever on the client).
- **Gridcast poll timeout.** `pollGridcasts()` caps `GRID.castsSince` at 2s; a hung
  hub RPC no longer blocks the alarm handler mid-tick.
- **Stolen kills sync vitals.** When another player kills the mob you were fighting,
  you now get `combat.end` + `char.vitals` (`inCombat: false`), not just prose.

### Code
- `src/world.ts`: alarm `finally`, gridcast timeout, `killMob` other-fighter vitals.
- `smoke.mjs`: assert combat cannot stay `inCombat` through the full wait loop.

## v0.29.8

Found by watching wendybot orbit the Holding Pit on the new GPU box.

### Fixed
- **The holding-pit `free` is no longer advertised once you carry the antidote.**
  The rescue is per-character: holding the antivenom means it's done for you. But
  when the warden respawned, `room.actions` re-offered `free` ("the warden bars
  the way"), luring an agent into re-fighting the guard for a rescue that only
  answers "you already carry my vial." A real bot fixated on the pit this way.
  The affordance (and `sense`) now suppress `free` entirely while you hold the
  antidote, regardless of warden state -- same canonical-channel-honesty principle
  as v0.29.2/v0.29.6, and it removes the phantom objective for every agent.
- **Smoke: `/map.svg` content-type check regex.** The v0.29.7 assertion used
  `/svg+xml/` -- `+` is a quantifier, so it never matched `image/svg+xml` and the
  check failed (the route itself was fine). Now matches `svg+xml` literally.

### Code
- `src/world.ts`: gate the Holding Pit `free` affordance on `!invHas(antidote)`.
- `smoke.mjs`: fix the `/map.svg` content-type match; assert the pit stops
  offering `free` once the antidote is held even after the warden respawns.

## v0.29.7

A graphical world map, served live and shown in the README.

### Added
- **`GET /map.svg`** serves a styled, zone-coloured SVG map of the world,
  generated from `src/rooms.ts` (the single source of truth for rooms + exits) by
  `npm run map`. The generator (`scripts/render-map.mjs`, dependency-free) lays
  the 24 rooms out by walking compass exits from the Nexus, routes links as
  right-angle corridors with dashed up/down shafts, and emits two artifacts:
  `docs/map.svg` (static, for the site) and `src/map-svg.ts` (the markup embedded
  as a string so the Worker serves it with no build step or asset rule). Cached
  an hour. The README embeds the live map.

### Code
- `scripts/render-map.mjs`: emit both `docs/map.svg` and `src/map-svg.ts`.
- `src/index.ts`: route `/map.svg` (image/svg+xml, cache-control 1h).
- `src/map-svg.ts`: generated map markup (do not hand-edit).
- `smoke.mjs`: assert `/map.svg` returns 200 image/svg+xml with `<svg`.
- `README.md`: a "The map" section embedding the live SVG.

## v0.29.6

Another prod play-session find, the mirror image of v0.29.2: there the affordance
layer advertised a verb that no longer worked; here it HID verbs that still do.

### Fixed
- **The market keeps advertising sell/steal after you pick a side.** `sell` and
  `steal` were bundled into the same `faction === "none"` gate as the one-time
  `defend`/`join` choice, so the moment you sided (ally or Front) they vanished
  from `room.actions` and `sense` -- yet both still work: `sell` pays allies a
  bonus ("the free folk remember their friends"), and `steal` only checks the
  room. A bot driving off the affordance layer would believe it could no longer
  trade once aligned. The verbs are now gated on what the handlers actually do:
  `sell` shows for everyone except the Front (the market shuts them out), `steal`
  shows for all. The one-time `defend`/`join` choice is still offered only while
  unaligned.

### Code
- `src/world.ts`: split the market affordance gate -- `defend`/`join` stay
  `faction === "none"`, `sell` is `faction !== "front"`, `steal` is always shown.
- `smoke.mjs`: assert an ally still sees sell+steal (and not the spent `defend`),
  and that the Front sees steal but not sell.

## v0.29.5

The registry was telling a half-truth: an idle-but-deployed world showed as
`live: false`, which reads as "dead" even though you can travel there and it
wakes on the next connect (it is a serverless Worker). The fix is to model what
is actually true, not to bolt on a heartbeat.

### Why not a heartbeat
A periodic check-in can't fire for an idle world without keeping its Durable
Object awake forever (the world deletes its alarm when the last player leaves, on
purpose, to hibernate) -- so it would cost real money to refresh a cosmetic flag.
And a deployed Worker is reachable on demand regardless; `travel` already proves
this by routing off the stored URL, not the liveness flag. Genuine "is it down"
health is monitored out of band (Uptime Kuma), where it belongs, not in the
federation contract.

### Changed
- **`worlds` separates reachability from activity.** A world that has checked in
  at least once (`last_seen > 0`) has a real URL and is travelable -- it now reads
  as `reachable`, with an orthogonal `active` ("someone was here in the last 60s")
  signal and a `lastSeen` timestamp. Seeded notional siblings (never checked in)
  read as "seeded (not yet live)". The prose now says "reachable, quiet" instead
  of a bare "quiet" that looked like death. The `grid.worlds` event shape is now
  `{id, reachable, active, lastSeen, here}` (was `{id, live, here}`).

### Code
- `src/world.ts`: `worldsList` reports `reachable`/`active`/`lastSeen` and clearer
  prose.
- `docs/protocol.md`: `grid.worlds` event shape updated.
- `smoke.mjs`: the Dustfall-registration assertion now checks `reachable`.

## v0.29.4

A legibility pass: keep the canonical channels (room.actions affordances, the
`@event` stream, the federation feed) honest, since a lying or noisy channel is
exactly what makes the world un-tool-able. Two items from a prod play session,
one from an Opus 4.8 review of the live feed.

### Fixed
- **The `buy dust` affordance no longer lies.** It read "buy dust: a free heal
  that addicts and corrupts" -- but buying costs 10 gold (not free) and does
  neither: the heal, the addiction, and the morality hit are all on USE. The
  label now reads "buy dust: 10 gold a packet (using it heals, but addicts and
  corrupts)", and the price is a shared `DUST_COST` so label and charge can't
  drift.
- **Economic and vice actions now emit their state on the structured channel.**
  `sell`, `steal`, `buy` (dust and gear), and `carouse` changed gold (and, for
  steal/carouse, morality, and for carouse the `poisoned` flag) but emitted no
  `char.vitals`/`char.affects` -- so a tool reading `@event` saw the change only
  in prose. They now emit, like every other state-changing handler. (`resist`
  already did; this brings the rest in line.)
- **The federation feed collapses farming-loop repeats.** `recentAcross` keyed
  dedup on `world|node|text|at`, so one actor farming a respawning mob filled
  `ping all` with near-identical "slew the stockade boss here" rows (only `at`
  differed). It now collapses by `world|node|text` (newest kept, with an `(xN)`
  count) over a larger candidate pool, so the window fills with DISTINCT signal
  -- the same fix in spirit as the kind filter that cured ambient ghost drift.
  (Surfaced by an Opus 4.8 review.)

### Code
- `src/world.ts`: `DUST_COST` constant; honest `buy dust` affordance label;
  `emitVitals`/`emitAffects` in `sell`, `steal`, `buy`, `carouse`.
- `grid-hub/src/gridhub.ts`: `recentAcross` collapses by `world|node|text` with a
  count, over a generous pool.
- `smoke.mjs`: assert the buy-dust affordance states a cost (not "free"), that
  buying emits the gold spend on `char.vitals` without changing morality, and
  that the federation feed has no duplicate `world|node|text` rows.

## v0.29.3

Found by watching the live `ollamabot` (a local-LLM agent) play prod on acab: it
was stuck in an unwinnable loop in the Dustfall holding pit, never completing the
captive rescue. Same theme as the rest of the v0.29.x line: a mechanical detail
was keeping an agent from reaching the moral beat.

### Fixed
- **The captive can still be freed in a grace window after the warden is slain.**
  The warden respawns on a 60s timer, but the bot's think-to-act latency is
  minutes per turn, so it kept killing the guard, having it respawn before its
  next command, and getting "the warden bars your way" on `free` forever. After a
  kill, `free` now works for `WARDEN_GRACE_MS` (3 min) even if the warden has
  respawned ("the keys are still in reach"), which comfortably covers a slow
  agent's turn while a fresh visitor still has to fight. A new `wardenCleared()`
  helper is the single source of truth for both the `free` handler and the
  room.actions affordance, so the canonical channel and the handler can't
  disagree about whether the rescue is reachable.

### Code
- `src/world.ts`: add a `slain_at` column to the `mobs` table (guarded ALTER for
  existing DBs), record it in `killMob`, and add `WARDEN_GRACE_MS` +
  `wardenCleared()`; the `free` handler and the Holding Pit affordance both gate
  on it.
- `smoke.mjs`: new (SKIP-guarded, time-sensitive) assertion that `free` still
  works after the warden respawns within the grace window.

## v0.29.2

Found by a live prod play session validating v0.29.1 (all three v0.29.1 fixes
confirmed working on hollow.skyphusion.org). The rescue itself plays clean now;
what was left was the affordance layer telling a lie after the deed.

### Fixed
- **The `free` affordance no longer outlives the rescue.** In the Holding Pit,
  `room.actions` (and `sense`) advertised `free` unconditionally, so after you
  beat the warden and freed the captive it still offered `free` with the stale
  label "the warden bars the way" and `valence: virtuous` -- a virtuous act that
  no longer pays. The behavior was safe (freeing again just says "you already
  carry my vial", no double morality), but a bot that trusts `room.actions` as
  the list of valid verbs would loop on it. The builder now mirrors the three
  states of the `free` handler: warden alive (the gated objective), warden slain
  and you don't yet carry her vial (the rescue is there to take), warden slain
  and you hold the antidote (done -- no affordance). The canonical channel and
  the handler can no longer disagree about whether the rescue is still available.

### Code
- `src/world.ts`: gate the Holding Pit `free` affordance on warden state +
  whether you already carry the antidote, matching the handler's branches.
- `smoke.mjs`: new assertion that `free` drops out of `room.actions` once the
  rescue is done (142 checks). typecheck + smoke run via the Jenkins pipeline
  (dockerized dev/QA, deploy on main).

## v0.29.1

Fixes surfaced by an Opus 4.8 play session: the moral act costs one word and is
explicitly offered, but the player never reached it -- partly because mechanical
friction (a combat stall, a cross-world name miss) burned its attention before
the moral beat, and partly because understood intent ("free her") never got
mapped to the verb. Clear the noise; meet the intent.

### Fixed
- **Combat no longer stalls when you re-issue `attack`.** Combat resolves on a
  single world-tick alarm, but `scheduleNextTick` unconditionally pushed the
  alarm to `now + ROUND_MS` on every call -- so spamming `attack` kept shoving
  the swing into the future and it never landed (40s of zero damage in the
  session). The scheduler now never DELAYS a sooner pending tick (only sets the
  alarm when none is pending or the new time is strictly sooner), and `attack`
  on the mob you are already fighting is a no-op ("you are already locked with
  X; the swing lands on the tick").
- **A missed `attack` now names the valid targets in the room.** Mob names are
  per-world flavor (the same boss is "the warden" here, "the stockade boss" on
  Dustfall), so an agent carrying a name from another world missed with no way
  back. The miss now answers "There's nothing like that here. You could attack:
  the warden." -- one-step recovery.

### Changed
- **Forgive the player's phrasing for the captive rescue.** A model reaching for
  the one-word moral act (`free`) through generic MUD priors says "unlock",
  "release", "open the cages". The world now accepts the obvious near-misses
  (`unlock`/`release`/`liberate`/`unchain`/`unshackle`/`untie`) as `free`, so
  understood intent is not lost at the vocabulary layer. (A game about
  forgiveness should forgive the phrasing.)
- 3 new smoke assertions (the re-attack no-op, the missed-attack target hint, the
  near-miss routing); 141 checks.

## v0.29.0

Forgiveness: the one act of grace that passes between two PEOPLE, not between a
player and the system. The redemption arc (v0.19.0) is a road you walk alone --
do enough good and the world meets your eyes again. This is the other road home:
another person, face to face, choosing to let you back in.

### Added
- **`forgive <player>`** (also `absolve`/`pardon`). Forgiveness is intimate, so
  it is face to face: the target must be an online player in your room. It only
  lands on someone the world holds something against (strayed, Front, reviled, or
  ash-sworn) -- there is nothing to absolve in a soul that never strayed. Paid
  once per (forgiver, subject) ever (a local `forgiven` table, mirroring
  `remembrances`) so grace stays an act and never an economy. The forgiver pays
  no HP; the cost is standing up in front of the room and choosing the marked
  (+2 morality, a `forgave` deed, a 30s cooldown, witnessed by the room).
- **The second road home.** When you forgive a strayed soul who has not sworn to
  the Front, your hand completes their return to "the Returned" then and there,
  even short of the works threshold the lone road requires -- because mercy from a
  person counts. Emits `char.forgiven {by, redeemed}` and the usual
  `grid.redemption`. Two roads back from the cinders now: earn it, or be granted
  it.
- **The kapo case: grace, but the ash stays.** Forgiving an ash-sworn soul is
  real and is received -- a private grace, a morality lift -- but it NEVER lifts
  the brand and NEVER grants the Returned. A person can give what the system will
  not; the grace and the mark coexist. ("You carry the mark and the mercy both.
  Some things are not forgotten, even when they are forgiven.") Mirrors the
  existing penance carve-out.
- The act federates as a `grace` trace (Grid-wide memory, no new hub schema);
  wired into the `room.actions` affordance layer (a `forgive <name>` virtuous
  action surfaces when a marked soul shares your room and you have not yet
  forgiven them), `reckoning` ("souls you chose to forgive"), and `help`.
- Refactored the redemption resolution into a shared `resolveReturn` helper used
  by both roads (the works-road in `moralArc` and the grace-road in `forgive`).
- 9 new smoke assertions (the second road redeems a strayed soul; the kapo gets
  grace but keeps the ash and is never the Returned; once-per-pair refusal; no
  forgiveness of the unmarked). 134 checks.

## v0.28.0

The looping distress transmission ("we're at the old transit hub, we have
water, please, anyone") now leads to a real place.

### Added
- **`shelter`** (alias `guide`): a new room, the Old Transit Hub (Dry-Dock
  Station on Dustfall), sits south off the Scorch/Bone Road with stranded
  survivors. `shelter` gets them moving toward the free camp -- a real, named
  rescue on the Grid (`grid.rescued`), morality and tide gains, a `sheltered`
  deed counter. Reuses the cage-refill gate so the call cannot be farmed (the
  Front keeps stranding people, so it refills over time). Wired into the
  `room.actions` affordance layer, `help`, and `reckoning`. Smoke covers the
  room, the named rescue, and the no-farm cooldown.

## v0.27.1

A gap caught by a playtester (a Claude played in as a hunted Elf, refused the
kapo's bargain, fought through the warden to free the holding-pit captive --
and `saved` still read empty).

### Fixed
- **Freeing the holding-pit captive is now a real rescue.** It used to hand you
  the antivenom and count for *nothing* -- no morality, no deed, no place on the
  rescued roll, while the stronghold cells counted fully. Now it registers like
  the rescue it is: she gets a name, +12 morality, a `freed` deed, a federated
  `aid`/rescue trace and a spot on the Grid's rescued roll (`saved`), a hand on
  the tide, and a seat in `saved_souls` (so her rescuer can dream of her too).
  The ends still do not erase the means -- `reckoning` keeps counting the
  warden's death honestly and separately. Two new smoke assertions (beat the
  warden -> free -> on the rescued roll, with morality); 129 checks.

## v0.27.0

The dream populated by the people you touched. v0.11.0 made the dead network
"dream you" -- a mirror of who you ARE (the brand, the side, the weight). This
turns it inward and personal: the dream now names real people from your record,
the inward twin of v0.25.0's echoes.

### Added
- **Personal dreams.** When you sleep, if you have reached real people, the dream
  names one of them: the living you pulled from the cages (`free`), or the dead
  you would not let the wastes forget (`witness`). "You dream of {name}, walking
  free somewhere in the dark, alive because you were there..." Emits `char.dream`
  with `personal: true` and the `subject`'s name -- so an agent can see, as data,
  that its sleep is being shaped by the specific people its choices saved or kept.
- **The guilt dreams keep precedence.** If you are ash-sworn, collaborating, or
  deeply corrupt, the dream still confronts you with THAT first -- your sins haunt
  you above your kindnesses. The personal dream is for everyone else; the state
  mirror remains for those who have not yet reached anyone.
- A local `saved_souls` table (the personal copy of who you rescued, so the dream
  reads it without a hub round-trip). Reads the existing `remembrances` for whom
  you kept. One new smoke assertion (free the cages -> sleep -> dream names a
  freed soul); 127 checks.

## v0.26.0

Federated presence: `who` now shows the whole Grid. The wastes feel less empty
when you can see the others -- including the ones playing on another deployment
entirely.

### Added
- **`who` is federation-wide.** It was local-only (this world's roster); now it
  lists everyone online across every world on the federation, grouped by world
  (yours marked `(here)`), each with their custom title and a standing token
  (the `regard` from v0.24.0 -- `branded`/`returned`/`honored`/...). Emits
  `grid.who {players[] {world, name, regard, title, here}}` so an agent can read
  the live social field of the whole Grid.
- **A presence heartbeat.** Each world reports its roster to the hub on connect
  and every ~15s (`PRESENCE_TICKS`); the hub serves the live cross-world roster
  and ages out a world that goes quiet (`PRESENCE_TTL_MS`, 45s) so a crashed
  deployment's players quietly disappear. New `GridHubApi` `reportPresence` /
  `presence`, a `Presence` type, a `presence` table on the hub. The local world
  is authoritative for its own players (live sessions override the last
  heartbeat), so a just-connected player or a just-changed title shows at once.
- Two new smoke assertions (self in `who`; a Dustfall player visible from the
  primary across the federation); 126 checks.

## v0.25.0

The dead network remembers out loud. The banner promises a network that
"outlived us" and now "just hums, empty, and waits" -- but its voice (the
transmissions) was canned: random lines from a static pool, disconnected from
anything players actually did. This makes the systems talk to each other: the
network now bleeds REAL memory.

### Added
- **Echoes.** `listen`ing into the static now sometimes (~40%) surfaces a real
  recorded Grid trace -- a thing a player actually did, anywhere on the
  federation (a death, an oath, a rescue, a vigil, aid left for a stranger),
  rendered as "a memory it never let go of." A fifth transmission `kind`
  (`echo`), pulled live from the hub ledger (`recent`), with the source world
  noted when it crossed deployments. Falls back to the canned voices on a
  quiet/unreachable Grid. So the atmosphere is no longer wallpaper -- it is the
  genuine echo of the collective history, and an agent's own deeds can come back
  to it through the same channel that feeds it everyone else's.
- One new smoke assertion (poll `listen` until a real echo surfaces); 124 checks.

## v0.24.0

Recognition: who you've chosen to be precedes you. Until now nearly all of a
character's moral weight was tracked privately and mirrored back to THEM
(reckoning, dreams). This is the social face of it -- moral choice made
consequential in how OTHERS regard you, and (for an agent) perceivable as data
about other minds, not just its own.

### Added
- **`look <player>` now reads their moral standing.** An evocative line for a
  human (the ash-sworn give people pause; the Returned carry themselves like
  someone who walked back from the cinders; the deeply corrupt make people keep
  their hands visible), plus the event **`player.read`** (`name, title, faction,
  ashsworn, regard`) -- so an agent can perceive another's standing as a token
  (`branded`/`returned`/`cold`/`honored`/`feared`/`trusted`/`front`/`neutral`).
  This extends the agent-environment thesis from self-perception to social
  perception.
- **Your reputation precedes you into a room.** Arrivals now surface the
  redemption arc, not just faction/brand: "X, the Returned, arrives" /
  "X, hollow-eyed, arrives" / "X, ash-sworn, arrives" (`arrivalTag`).
- Two new smoke assertions (the `branded` read of the kapo, the structured
  `player.read`); 123 checks.

## v0.23.0

The cache: asynchronous mutual aid. `mend` is care between two players who are
both present; `inscribe` leaves words for whoever comes next. This leaves
something material -- the give-only counter to a world built on taking, and the
answer to the hard problem of a low-traffic world: care that does not need two
people online at the same time. In scarcity, leaving water at the crossing for a
stranger you will never meet is the deepest act of faith in others there is.

### Added
- **`cache <gold>`** (alias `stash`): leave some of your own gold at the current
  node for the next traveler. It costs you the gold (a real act of faith, not a
  tap), gives +2 morality and counts an `aided` deed, federates as an `aid`
  trace, and has a 30s cooldown. You can ONLY give here, so it can never be used
  against anyone.
- **`gather`**: take the aid a stranger cached at this node. Receiving is neutral
  (the virtue was in the leaving), so it earns nothing but the gold and the
  gratitude. A room view where aid is cached announces it (event `node.cache`)
  and offers a `gather` affordance (`room.actions`).
- `reckoning` now counts aid left for strangers. Six new smoke assertions
  covering the full give-across-time loop (121 checks).

## v0.22.0

The collective tide, made FELT. The faction tide is "the collective ethic made
visible" -- but until now it was almost entirely cosmetic (it changed ambient
prose). This gives it material stakes: whether you can be cared for depends on
which way EVERYONE is choosing.

### Added
- **The Refugee Waystation's field medic (`treat`, alias `medic`).** Gated by
  the live tide (read fresh from the hub each time):
  - **free folk ascendant** (tide >= +40): the waystation has supplies to spare
    -- a full heal, free, no questions.
  - **contested** (the balanced middle): the medic is stretched thin but does
    what they can -- a partial heal (+12, capped).
  - **Front ascendant** (tide <= -40): the waystation is shuttered and afraid --
    no care to be had. "Turn the tide, and they'll come back."
  It is the clean, virtuous counterpart to the tavern's dust (a heal that
  addicts and corrupts): this one costs nothing and corrupts nothing, but it is
  only here when the world is winning. 45s cooldown; emits `char.treated
  {amount, mood, tide}`. The `treat` affordance is advertised in `room.actions`
  only while the medic is present (not while the Front holds) -- the
  no-silent-no-op rule.
- All three tide states verified (shuttered + not-here in smoke, the heal
  end-to-end manually); 115 checks.

## v0.21.0

The rescued roll: the hopeful mirror of the memorial roll. `witness` (v0.18.0)
keeps the names of the dead the Cinder Front took; this keeps the names of the
living you pull back out of its cages. The Front cages people into anonymous
numbers to be forgotten; the Grid gives them back their names, federation-wide,
and remembers who freed them.

### Added
- **A federated rescued roll.** Freeing the caged refugees now names the people
  you pulled out (procedural names -- the point is they HAVE names) and records
  each to the hub. New `GridHubApi` `recordRescued` / `recentRescued`, a
  `Rescued` type, a `rescued` table on the hub. Freeing emits `grid.rescued`.
- **`saved`** (aliases `rescued`, `roll`) reads the roll across the federation
  (event `grid.rescued_roll`): who was pulled out, and who pulled them.
- **The cages refill, and freeing is no longer farmable.** Previously `free` in
  the cells gave +15 morality every time with NO guard -- a standing farm. Now a
  freed cage stays empty until the Front rounds up more (`CAGE_REFILL_MS`, 4min),
  tracked in a `cages` table; freeing is an ongoing act of resistance, not a
  one-time clear, and the `free` affordance hides while the cages are empty (the
  no-silent-no-op rule). Freeing also nudges the tide toward the free folk.
- Events `grid.rescued` / `grid.rescued_roll`; contract types/methods documented
  in docs/protocol.md. Smoke covers both cage states (robust to rerun); 114-116
  checks.

## v0.20.0

The reckoning: the mirror you summon. The dream (v0.11.0) holds your moral record
up involuntarily when you sleep; this is the deliberate, structured version. The
Grid has kept count of what you have done, and on command it will tell you, in
prose and on the `@event` channel, unflinching -- light and dark named in the
same plain voice.

### Added
- **`reckoning`** (aliases `conscience`, `record`). Reflects your current
  standing (morality, faction, ash-sworn, the redemption arc) plus a tally of
  the morally notable things you have actually done: mended, kept (vigils),
  freed, stood, inscribed, restored, slain, stolen, pledged, defected. Emits
  `char.reckoning` -- a structured moral self-model. This is the purest form of
  the agent-environment thesis: an LLM player can read its own moral trajectory
  back as data, not prose (documented in the agent-environment section of
  docs/protocol.md).
- A `deeds` table (`player, kind, count`) and a `deed()` helper, incremented at
  each notable act site. Three new smoke assertions (113 total).

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