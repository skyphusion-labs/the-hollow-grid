# Authoring a world (content packs)

The engine is generic; a world is data. The Hollow Grid and Dustfall run the
**exact same code** and differ only in content selected by one environment
variable, `WORLD_MAP`. This is the moddability seam: a world is content plus a
few env vars, not a fork of the engine. This guide shows how the per-world
selection works and how to add a new world.

## The model

Each piece of per-world content is chosen at startup by a `*For(WORLD_MAP)`
selector, threaded onto the running `World` instance:

| Content | Selector | Lives in | Instance field |
| --- | --- | --- | --- |
| Room map (names, descriptions, exits) | `mapFor` | `src/rooms.ts` | `this.rooms` |
| Bestiary (creatures, stats, loot) | `mobsFor` | `src/mobs.ts` | `this.mobTemplates` |
| Shop stock | `waresFor` | `src/items.ts` | `this.wares` |
| Starter weapon | `starterFor` | `src/items.ts` | `this.starter` |
| Login banner (title, palette, voice) | `bannerFor` | `src/banner.ts` | `this.banner` |
| "Where you wake" welcome clause | `introFor` | `src/rooms.ts` | `this.intro` |

An unknown or unset `WORLD_MAP` falls back to The Hollow Grid, so single-world
play is unaffected. Item *definitions* stay a shared catalog in `src/items.ts`
(harmless data, referenced widely); only what each world hands out is per-world.

## The shared anchors (do not let these drift)

A world's content is reskinnable, but the engine and the federation anchor on a
small set of stable ids. A new world should reuse these ids (reskinned freely)
so the faction arc, the shop, the quest, the prison, and the stronghold keep
working. Both shipping worlds do exactly this.

- **Room ids with special logic:** `nexus` (start), `market` (faction
  recruiter), `dais` (the Ashmonger / faction climax), `workshop` (the shop),
  `tavern` (vices), `holding_pit` (prison), `checkpoint`/`waystation`/`gate`/
  `muster`/`cells`/`warroom` (the Cinder Front stronghold), `floodgate`
  (quest-giver). The full graph is 23 rooms; keep the ids, change the prose.
- **Mob ids the logic depends on:** `warden` (drops the `keycard`), `custodian`
  (drops the quest `shard`), `ashmonger` (the faction boss; killing it shifts the
  global tide and triggers a federation-wide broadcast). The Cinder Front
  rank-and-file are the same enemy everywhere, by design.
- **Item ids:** the quest `shard`, the warden's `keycard`, and the Ashmonger's
  `cleaver` are referenced by the arc. New worlds can add their own gear freely.

The Cinder Front, the bosses, and their drops stay shared across worlds because
the faction war is federation-wide; only the regional flavor (rooms, wildlife,
salvage, banner, voice) changes. This keeps two worlds feeling distinct while
the shared Grid (tide, identity, ledger, travel) stays coherent.

## How Dustfall is built (the worked example)

Dustfall (`WORLD_MAP=dustfall`) is the open salt pan people fled to, against The
Hollow Grid's enclosed neon rot. It reuses every room id and exit, the load
bearing mob ids, and the quest, but:

- `ROOMS_DUSTFALL` rewrites all 23 rooms' prose (`mapFor` returns it).
- `MOBS_DUSTFALL` is expressed as *overrides* on the base templates (so ids and
  rooms cannot drift), reskinning the regional wildlife and swapping its loot to
  Dustfall gear; the Cinder Front mobs are untouched.
- Dustfall salvage (`machete`, `spear`, `hide`, `wrap`, `waterskin`, `saltbrick`)
  is added to the shared item catalog, balanced against the Hollow Grid set;
  `waresFor`/`starterFor` hand it out, and the Dustfall mob loot drops it.
- A rust-and-sand `bannerFor` spec and a salt-pan `introFor` clause.

## Races

Races are data too (`src/races.ts`), but they sit a little differently from the
map/bestiary/items: a race is a **federated, canonical attribute** chosen once at
character creation that follows you across worlds, so the Grid Hub carries the
race id as an opaque `CharSheet.race` string and never gatekeeps it. A race is
mostly NARRATIVE: its load-bearing field is `stance` (how the Cinder Front treats
this people: `accepted` | `tolerated` | `hunted`), which the faction-reactive
rooms read. The mechanical leans (hp/damage/armor/regen, poison immunity) are
deliberately light.

Each race also has an active **signature ability** (`Ability` in `src/races.ts`):
a cooldown-gated command, used by its named verb or the generic `ability`/`trait`,
resolved in `useTrait` (`src/world.ts`). They lean into identity rather than
balance (Elf Vanish escapes a fight, Chromed Overclock bursts a target, Dustkin
Forage scavenges the open wastes, Revenant Commune reads the dead Grid, and so
on). The passive leans (hp/damage/armor/regen, poison immunity) still apply.

In this codebase both worlds share one roster (`RACES`), so the Front's stances
stay coherent federation-wide (the Front is one movement; elves are hunted
everywhere). The model is built for extension, though:

- **A world owns its roster.** A world (including a third party) can define any
  races it likes. `raceFor(id)` returns undefined for a race it does not know.
- **Unknown races degrade gracefully.** When a traveler arrives carrying a race
  the destination world has never heard of, the label still travels (it shows in
  `whoami`), but local mechanics default and `stanceFor` falls back to
  `tolerated`. The character is never broken.
- **The long-term shape** is a small shared canon of well-known races + their
  stances in `shared/`, which worlds honor, plus local extensions. Same
  fediverse logic as content packs: a shared standard, local color, opt-in. See
  `docs/federation.md`.

### The kapo (a designed special case)

An **elf who joins the Cinder Front** is the federation's kapo: one of the hunted
turning on his own people. The game marks this as `ashsworn` on the `CharSheet`,
a **permanent brand** the hub enforces as write-once true (it never clears, even
on defection). It carries the heaviest morality cost on the board, the Front
tolerates-with-contempt rather than accepts him, the free folk react with the
deepest revulsion, and the public `brand` shows `ash-sworn` above any faction.
This is intentional weight, handled with gravity; treat it as such if you extend
it. (Detected as `race === "elf" && faction === "front"`; see `factionChoice` and
`brandAshsworn` in `src/world.ts`.)

## Adding a new world

Two paths:

1. **TypeScript content pack (this repo)** -- same engine, new `WORLD_MAP` selector
   (the Dustfall recipe below).
2. **Alternate engine (port)** -- reimplement the world server in another language
   against `docs/protocol.md`. **Rust Choir** ([hollow-grid-go](https://github.com/SkyPhusion/hollow-grid-go))
   is the live example: canonical map + a grafted signature zone, registered on
   the hub via HTTP RPC from the fleet. See `hollow-grid-go/docs/WORLD.md`.

### TypeScript content pack (Dustfall recipe)

Say you want `saltreach` (already seeded as a stub in the registry):

1. **Rooms** -- in `src/rooms.ts`, add `ROOMS_SALTREACH` (reuse the 23 room ids
   and exits; rewrite names/descriptions). Extend `mapFor` and `introFor` to
   return your map / wake-clause for `"saltreach"`.
2. **Mobs** -- in `src/mobs.ts`, add `MOBS_SALTREACH` (overrides on the base
   templates is the safe pattern) and extend `mobsFor`.
3. **Items** -- if your world wants distinct gear, add the item definitions to
   the shared `ITEM_TEMPLATES` and add `WARES_SALTREACH` + branches in `waresFor`
   and `starterFor`. Reusing existing items is fine too.
4. **Banner** -- in `src/banner.ts`, add a `BannerSpec` (title, kicker, flavor,
   tagline, palette) and a branch in `bannerFor`. A new banner is a few lines.
5. **Deploy config** -- copy `worlds/dustfall.jsonc` to `worlds/saltreach.jsonc`,
   set `name`, `WORLD_NAME`, `WORLD_MAP=saltreach`, a distinct dev `port` and
   `inspector_port`, and the production `WORLD_URL`. Add it to the `dev`/`deploy`
   scripts. See `docs/deploy.md`.
6. **Verify** -- `npm run typecheck`, then `npm run dev` and connect to your
   world's port; `npm run smoke` should stay green (the federation phase asserts
   cross-world identity/tide/travel and is content-agnostic).

That is the whole recipe: content + three env vars (`WORLD_NAME`, `WORLD_MAP`,
`WORLD_URL`) and a wrangler config. The longer-term direction is to lift this
content out of the repo entirely into loadable packs, so a world is a file
someone drops in rather than a code change, plus a trust/auth layer so a stranger
can point their pack at the Grid. The `*For(WORLD_MAP)` selectors are the seam to
generalize. See the federation caveats in `docs/federation.md`.
