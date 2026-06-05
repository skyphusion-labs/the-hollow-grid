# The Hollow Grid Federation — design

Status: design draft. No code yet; this is the thing we build against.

## 0. The pitch

Multiple independently-run MUD worlds ("nodes") link to one shared backend
("the Grid") to share identity, memory, and global state — while each world stays
its own autonomous game.

This is diegetic, not bolted on. The Hollow Grid's whole premise is a dead
network that outlived its makers. Worlds are **nodes** on that network; the
shared backend **is** the Grid. Federation is canon, not plumbing.

Guiding principle: **federation is additive, never a hard dependency.** Every
world must run standalone with the Grid unreachable, and reconcile later. We are
not building a single point of failure; we're building a network worlds can
*choose* to be part of.

## 1. Topology (on Cloudflare)

```
   world A (Worker + World DO)        world B (Worker + World DO)
   - rooms, mobs, combat (local)      - its own rooms/mobs (local)
   - service binding -> Grid          - service binding -> Grid
            \                                   /
             \                                 /
              v                               v
        ============  THE GRID (backend Worker)  ============
        - Grid Hub Durable Object (single global instance):
            real-time: presence, cross-world chat fan-out, faction tide
        - D1 (shared SQLite, bound to the backend):
            durable: accounts, canonical character sheets,
                     the cross-world Grid ledger, world registry
```

- **A world** = its own Worker + `World` DO. Owns all *local* state: its room
  graph, mobs, combat, local quests, a player's current room/hp/position.
- **The Grid** = a dedicated backend Worker that owns the shared **D1** (durable)
  and a **Grid Hub** DO (real-time). Worlds reach it via a **service binding**
  (Worker→Worker RPC) authenticated with a per-world key. Worlds never talk to
  each other directly — everything goes through the Grid.

Why this split: D1 is the only Cloudflare primitive multiple Worker scripts can
share as a queryable SQL store (the "common DB"). A single Hub DO gives a strongly
serialized coordinator for live fan-out (chat, tide, presence). Service bindings
are how separate deployments call one backend.

## 2. The trust model (the crux — design this first)

If different people run worlds, the backend cannot trust what a world reports.
This is the whole ballgame.

- **The Grid owns the canonical character.** Level, XP, gold, faction, morality,
  title — source of truth is D1, never the world.
- A world **leases** a character: on connect it `loadCharacter`s a snapshot +
  a lease token, plays locally, and **proposes** progression changes as *deltas*,
  which the Grid **validates against bounds** before committing (e.g. no more than
  N xp / M gold per commit window; faction transitions follow legal rules).
- Worlds are **semi-trusted**: honest worlds work; cheaty worlds get rate-limited,
  their bogus deltas rejected, and their key revoked. We are NOT solving Byzantine
  fault tolerance — the bar is "an honest world Just Works, a dishonest one gets
  caught and cut off."
- **Local state is free.** A world's rooms, mobs, and in-progress quests are its
  own business; the Grid neither knows nor cares. Only *shared* fields round-trip.

## 3. What's canonical where

| State | Canonical | Notes |
|---|---|---|
| Account (name, auth) | **Grid (D1)** | Worlds get scoped tokens, never raw creds |
| Progression (level, xp, gold) | **Grid (D1)** | Worlds propose deltas; Grid validates |
| Faction / morality / title | **Grid (D1)** | The faction arc is federation-wide |
| Inventory / equipment | **world (v1)** | Sharing needs cross-world item-id compat; defer |
| Current room / position | **world** | Your location in A is meaningless in B |
| HP / combat / transient | **world** | Per-session, never shared |
| The Grid ledger (ping traces) | **Grid (D1)** | The shared memory; tagged by world_id |
| Faction tide | **Grid Hub** | One global needle all worlds move |
| Presence / who's where | **Grid Hub** | Best-effort, real-time |

The key call: **share identity + progression + faction; keep inventory and all
transient state local (for v1).** Inventory federation is a real project of its
own (item registries, compatibility) and isn't where the magic is.

## 4. Join / trust protocol

1. A world operator registers out-of-band → receives `{ world_id, secret_key }`.
2. On boot the world calls `register(world_id, key, manifest{ name, url, version })`;
   the Grid records it live in the registry.
3. Every subsequent RPC carries the key; the Grid authenticates + per-world
   rate-limits.
4. **Versioned**: every payload has a `v` field; unknown fields are ignored
   forward-compatibly, so worlds and the Grid can upgrade independently.

## 5. Grid Hub API (RPC surface)

```
register(worldId, key, manifest)                  -> ok
resolveAccount(name, authToken)                   -> { accountId } | error
loadCharacter(accountId, worldId)                 -> { sheet, leaseToken }
commitDelta(leaseToken, delta)                    -> { ok, sheet } | rejected
recordGridTrace(worldId, node, kind, text)        -> ok
queryGrid({ node?, scope: 'node'|'world'|'all' }) -> trace[]
gridcast(worldId, from, text)                     -> ok        (fans out to all live worlds)
factionTally(delta?)                              -> tide      (read or contribute)
presence()                                        -> { worldId -> count }
```

The Hub fans `gridcast` out by calling each live world's inbound binding (worlds
expose a small `/grid-event` endpoint the Hub pushes to). Tide and presence are
read on demand and cached briefly in each world.

## 6. Player travel (the dream — a later phase)

A world offers a gateway room. `travel <world>`:
1. World A checkpoints the character to the Grid (`commitDelta`).
2. The player reconnects to world B's URL (handed off via the Grid registry).
3. World B `loadCharacter`s the same character into its start room.

**v1 simplification:** travel = "log out of A, log into B with the same account,
your progression follows." No live session migration — just shared persistent
identity. Live hand-off of an active socket is a v2 luxury.

## 7. The cheapest magic: the shared Grid ledger (build this first)

Every world `recordGridTrace`s its notable events (deaths, oaths, kills) to D1,
tagged with `world_id`. `ping` can query the ledger scoped to **all worlds**, so
you hear echoes from other nodes. "The network outlived us" becomes literal: the
Grid remembers across the whole federation.

This needs **zero trust machinery** — traces are lore/flavor, not progression —
so it's the highest-magic, lowest-risk first step. It also makes the federation
*visible and felt* before any of the hard identity work.

## 8. Consistency & failure

- **Durable (D1)** = source of truth for identity/progression; commits transactional.
- **Real-time (Hub)** = eventually-consistent, best-effort. gridcast/tide/presence
  may lag or drop; that's fine.
- **A world must work offline.** If the Grid is unreachable, the world runs with
  local-only state (and, optionally, a local character fallback) and reconciles on
  reconnect. Federation never blocks play.

## 9. Phased build

1. **Shared Grid ledger** — Hub/D1 + `recordGridTrace`/`queryGrid`, `ping --all`.
   Cross-world memory. No trust needed. (The cheap magic.)
2. **Cross-world comms + global tide** — `gridcast` + `factionTally`. Hub fan-out.
3. **Shared identity** — accounts + canonical character sheet in D1; worlds
   lease/commit progression. (The trust boundary; the big one.)
4. **Player travel** — gateways + account-follows-you.

## 10. The honest caveats

- This turns *a game* into *a platform for games.* That's a real commitment, a
  different project than "build The Hollow Grid." Worth being deliberate about.
- Trust is the hard part and it constrains autonomy: the more the backend owns,
  the more a "world" becomes a thin client of shared identity. The line we draw
  (share progression, keep inventory/local-content world-owned) is the lever.
- Most of the wonder (shared memory, a global faction war, cross-world chat, one
  character across worlds) is reachable with a *thin* shared layer. Resist
  building a metaverse; build the smallest thing that feels like a living network.
