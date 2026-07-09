# Running, deploying, and CI/CD

How to run The Hollow Grid locally, ship it to Cloudflare, and the GitHub
Actions pipeline that does it automatically.

## The three Workers

| Worker | Role | Public? |
| --- | --- | --- |
| `the-hollow-grid` | World A (the Hollow Grid map) | yes -- `hollow.skyphusion.org` |
| `dustfall` | World B (the Dustfall salt pan), same code, `WORLD_MAP=dustfall` | yes -- `dustfall.skyphusion.org` |
| `grid-hub` | the shared federation backend (tide, identity, ledger, registry) | no -- reached by both worlds over a service binding |

Players connect to a world over WebSocket at `/ws`, or open the world's domain in
a browser for the built-in xterm.js client. The hub has no public domain; it is
reached only by the worlds.

## Environment variables (per deployment)

Set in each world's wrangler config `vars`:

| Var | Meaning | Example |
| --- | --- | --- |
| `WORLD_NAME` | this world's name on the federation registry | `"The Hollow Grid"` / `"Dustfall"` |
| `WORLD_MAP` | which content pack to serve (see `docs/worlds.md`); unset = Hollow Grid | `"dustfall"` |
| `WORLD_URL` | the **production** address advertised to the registry for `travel` | `"wss://hollow.skyphusion.org/ws"` |
| `ADMINS` | comma-separated player names allowed to `wall` | `"skyphusion"` |

`WORLD_URL` carries the production `wss://` URL because that is what other worlds
hand a traveller. Local dev overrides it back to `ws://localhost:<port>` via
`--var` (see below) so the registry and `travel` point at the running dev servers
and the smoke suite's localhost assertions hold.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | the whole federation: World A on `:8787`, Dustfall on `:8788`, one shared hub. Two `wrangler dev` processes (see `scripts/dev.sh`). |
| `npm run dev:solo` | just World A + the hub on `:8787` (single-world hacking) |
| `npm run dev:dustfall` | just Dustfall on `:8788` (binds a hub running elsewhere via the dev registry) |
| `npm run typecheck` | `tsc --noEmit` on both Workers; the CI gate |
| `npm run smoke` | the end-to-end suite against a running dev (**135 checks**) |
| `npm run connect` | dependency-free terminal client (`-- ws://localhost:8788/ws` for Dustfall) |
| `npm run deploy` | deploy hub, then World A, then Dustfall |

## Local dev topology

`wrangler dev` serves only the **first** config of a multi-config invocation on a
port; the rest are auxiliary (reachable via bindings, not their own port). Two
worlds both need to accept player connections, so each runs as its own
`wrangler dev` process, and both bind the **one** hub through wrangler's local
dev registry (you will see `env.GRID ... [connected]`). This mirrors two separate
production deployments sharing one backend. Dustfall sets a distinct
`inspector_port` so its debugger does not clash with the primary's default 9229.

Wipe `.wrangler/state` for a clean run (the hub holds persistent shared state, so
smoke assertions can drift across runs otherwise).

## Deploying to Cloudflare

Prerequisites: a Cloudflare account with the target zone (here `skyphusion.org`)
active, and `wrangler login` (or `CLOUDFLARE_API_TOKEN` for headless).

```
npm run deploy     # = wrangler deploy -c grid-hub/wrangler.jsonc
                   #     && wrangler deploy                       (World A)
                   #     && wrangler deploy -c worlds/dustfall.jsonc
```

Order matters: the hub deploys first because the worlds bind it. Each world's
config carries a `custom_domain` route, so wrangler creates the DNS record and
provisions the TLS cert in the zone automatically:

```jsonc
"routes": [{ "pattern": "hollow.skyphusion.org", "custom_domain": true }]
```

For a fresh deploy to a different domain, set each world's `WORLD_URL` and
`routes[].pattern` to your hostnames. The hub needs no domain.

## CI/CD (GitHub Actions)

CI/CD runs in GitHub Actions (`.github/workflows/`); the former Jenkins pipeline
was retired in the Jenkins->GHA migration (#41). This repo is PUBLIC, so the
deploy job runs on a GitHub-hosted runner (fork-safe; no self-hosted build box
exposed to fork PRs).

- **ci.yml** (push + PR, deploys on `main`):
  - **Install** -- `npm ci`.
  - **Typecheck** -- `npm run typecheck` (the gate).
  - **Smoke** -- starts both worlds + the hub and runs the 135-check suite. Each
    world runs under its own process group via `setsid`, and teardown kills
    exactly those groups (`kill -- -$PGID`). It does **not** use `npm run dev`
    (whose `kill 0` would reach the CI runner) and does **not** `pkill` broadly.
    This safety is deliberate; preserve it.
  - **Deploy** -- on `main` only, runs `npm run deploy` (which chains hub ->
    hollow -> dustfall in the correct bind order). wrangler authenticates via the
    `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` GitHub Actions secrets
    (the token scoped to Workers Scripts/Routes + DNS + SSL on the zone).
- **typecheck.yml** -- the always-on hosted typecheck path.

A push to `main` runs the full pipeline and, on green, deploys. The runner uses
Node 24+ (the smoke suite uses the global `WebSocket`).

## Health endpoints

The world serves `GET /health` (liveness) and `GET /health/deep` (deep check;
see docs/protocol.md). All three public worlds expose these at the edge with no
Cloudflare Access app on the paths:

| World | `/health` | `/health/deep` |
| --- | --- | --- |
| Hollow Grid | `https://hollow.skyphusion.org/health` | `/health/deep` |
| Dustfall | `https://dustfall.skyphusion.org/health` | `/health/deep` |
| Rust Choir (Go) | `https://rustchoir.skyphusion.org/health` | `/health/deep` |

- **Monitoring** -- Gatus (status.skyphusion.org) polls `/health` (60s) and
  `/health/deep` (5min) with no Access headers.

## Rust Choir (third world, Go fleet)

Rust Choir is **not** a fourth Cloudflare Worker. It is the
[`hollow-grid-go`](https://github.com/SkyPhusion/hollow-grid-go) container on
biafra, tunneled at `wss://rustchoir.skyphusion.org/ws`. It registers with the
same Grid Hub via HTTP RPC (`GRID_HUB_URL=https://grid-hub.skyphusion.org/rpc`).

Deploy and roll are owned by `hollow-grid-go` CI → `fleet-chezmoi`
`rust-choir-roll`, not `npm run deploy`. See
`fleet-chezmoi/system/swarm/RUNBOOK-rust-choir-roll.md`.

Score the Go port with the same suite this repo ships:

```bash
MUD_URL=wss://rustchoir.skyphusion.org/ws \
DUSTFALL_URL=wss://dustfall.skyphusion.org/ws \
node smoke.mjs
```

LLM load bots for all three worlds: `fleet-chezmoi/system/stacks/biafra/mud-bots/README.md`.
