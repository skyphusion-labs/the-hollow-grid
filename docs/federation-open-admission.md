# Open federation admission and hub authority

Status: **design only** (the-hollow-grid#62). Not implemented. The live
federation still trusts every registered world (see `docs/federation.md`
§2 / §10). This document turns Conrad's open-federation vision and Mackaye's
intake assessment into an authority model we can implement without opening
security holes.

**North star.** Any server that passes the conformance suite can join the Grid,
with admission as automated as we can safely make it — without giving every
member full write authority over shared state.

**Non-goal.** Byzantine fault tolerance across hostile majorities. The bar is:
honest members Just Work; dishonest members get rate-limited, rejected, and
cut off (revoke + quarantine), same as `docs/federation.md` §2.

## 1. Why conformance alone is not enough

Conformance (the mud-bots `@event` suite against an applicant endpoint) proves
**protocol compliance at admission time**. It says nothing about post-admission
behavior. Today every member can:

| Surface | Risk if open |
| --- | --- |
| `CommitCharacter` / sheet write | Overwrite any character's gold/level/standing (including players who never visited the member) |
| `ShiftTide` / faction tally | Yank war state network-wide |
| `GridCast` | Spam every world |
| Rescued / Fallen ledgers | Fabricate shared memory |
| Hub Worker + storage | Open members = our bill and DoS surface |

So: **conformance = admission FLOOR.** Above it we need scoped authority,
validation, and revocation — the fediverse lesson (scoped authority +
defederation), not "trust the suite forever."

## 2. Authority model

### 2.1 Per-member identity

- Each member world receives a **scoped member token** (not a shared fleet
  secret) at admission.
- Every hub write is tagged with `origin_world_id` derived from that token
  (never from a client-supplied field alone).
- Tokens are rotatable and revocable without redeploying the hub.

### 2.2 Home-world authority for character sheets

Canonical progression (level, XP, gold, faction, morality, title) remains
**Grid-owned** (`docs/federation.md` §2–3). Open admission tightens *who may
propose deltas*:

1. **Home world** = the world that first created / last accepted the character
   as resident (recorded on the sheet).
2. Only the home world may propose **canonical commits** for that sheet.
3. Visiting worlds may submit **deltas** (or lease proposals) that the home
   world countersigns, **or** that the hub validates against rate/bounds rules
   when the home world is offline (with stricter caps).
4. Cross-world `travel` still loads the Grid sheet; it does not grant the
   destination world commit rights over another world's residents.

This closes the crown-jewel hole: a hostile member cannot overwrite a player
who never visited it.

### 2.3 Hub-side validation (all members)

Independent of home-world rules, the hub enforces:

- Per-member **rate limits** on tide, casts, ledger writes, and commit attempts.
- **Bounds** on progression deltas (max XP/gold per window; legal faction
  transitions) as already sketched in `docs/federation.md` §2.
- Payload size / fan-out caps on `GridCast`.
- Ledger writes tagged with origin; optional quarantine of a member's traces.

### 2.4 Revocation, quarantine, defederation

| Action | Effect |
| --- | --- |
| Revoke token | Member cannot authenticate; immediate |
| Quarantine | Mark `origin_world_id` writes as untrusted; hide from default `ping` / casts |
| Rollback (optional, ops) | Soft-delete or tombstone a time window of that member's commits/traces |
| Defederation | Config change: drop registry row + revoke; not an incident response |

Defederation must be a **config change**, not a heroics runbook.

## 3. Automated admission Worker

Feasible once the authority model above exists:

1. Applicant registers an HTTPS endpoint + claimed `world_id`.
2. Admission Worker runs the **conformance suite** (mud-bots `@event` gate)
   against that endpoint.
3. On green: mint a scoped member token, record attestation
   `{ suite_version, timestamp, endpoint, world_id }`.
4. On red: refuse; no token.
5. Re-attestation on a schedule or on suite version bump.

Conformance remains necessary; it is not sufficient without §2.

## 4. Ernst / policy lane (out of protocol)

Member-server Terms of Service, abuse policy, and attestation terms are
**operator/legal** work, not wire-protocol work. Track separately; do not block
the technical authority model on a finished ToS, but do not open automated
admission to strangers without one.

## 5. Implementation phases (proposed)

Ordered to keep the single-operator fleet safe while we harden:

| Phase | Deliverable | Opens third parties? |
| --- | --- | --- |
| A | Per-member tokens + origin tagging on all hub writes | No |
| B | Home-world commit rule + visiting delta path | No |
| C | Hub rate/bounds validation (tide, cast, ledger, commits) | No |
| D | Revoke / quarantine / defederation ops path | No |
| E | Admission Worker + conformance attestation | **Yes (gated)** |

Do not enable Phase E against the public internet until A–D are live and soaked
on the existing TS / Go / Python members.

## 6. Relationship to as-built docs

- Wire contract: `docs/protocol.md` §3 / `shared/grid.ts` (`GridHubApi`).
- Topology and north-star trust: `docs/federation.md`.
- Conformance gate (today): mud-bots `@event` suite; fleet layout in
  `fleet-chezmoi` mud-bots stack docs.
- Ports: hollow-grid-go (Rust Choir), hollow-grid-py (Verdigris Spool) already
  speak the hub HTTP RPC; they become the first non-Workers members under
  scoped tokens in Phase A.

## 7. Explicit non-starts

Per issue #62 intake: **do not implement open admission without Conrad's GO**
(spend, DoS surface, and irreversible trust expansion). This document is the
design artifact so that GO has something concrete to approve.

## 8. Acceptance for this design doc

- [x] Captures vision, risks, and authority model in-repo.
- [ ] Linked from `docs/federation.md` §10.
- [ ] Implementation issues filed per phase A–E when Conrad authorizes build.
