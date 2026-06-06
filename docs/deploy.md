# Running, deploying, and CI/CD

How to run The Hollow Grid locally, ship it to Cloudflare, and the Jenkins
pipeline that does it automatically.

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
| `npm run smoke` | the end-to-end suite against a running dev (81 checks) |
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

## CI/CD (Jenkins)

A `Jenkinsfile` at the repo root defines the pipeline; a multibranch job builds
each branch.

- **Install** -- `npm ci`.
- **Typecheck** -- `npm run typecheck` (the gate).
- **Smoke** -- starts both worlds + the hub and runs the 81-check suite. Each
  world runs under its own process group via `setsid`, and teardown kills exactly
  those groups (`kill -- -$PGID`). It does **not** use `npm run dev` (whose
  `kill 0` once SIGTERM'd the Jenkins controller) and does **not** `pkill`
  broadly on the shared controller. This safety is deliberate; preserve it.
- **Deploy** -- on `main` only, runs `npm run deploy`. wrangler authenticates via
  a `cloudflare-api-token` Jenkins credential exposed as `$CLOUDFLARE_API_TOKEN`
  (Secret text, scoped to Workers Scripts/Routes + DNS + SSL on the zone).

A push to `main` triggers the webhook, which triggers a repo scan, which builds
and deploys. Multibranch build strategy must allow branch builds (the default
empty `<buildStrategies/>`); a tags-only strategy will detect the change but log
"No automatic build triggered" and never build.

Agent requirements: Node 24+ on PATH (the smoke suite uses the global
`WebSocket`).

## Health endpoints + Cloudflare Access

The world serves `GET /health` (liveness) and `GET /health/deep` (deep check;
see docs/protocol.md). At the Worker layer both are unauthenticated; the prod
deployment gates them at the edge with a Cloudflare Access self-hosted
application:

- **App** -- "The Hollow Grid Health", domain `hollow.skyphusion.org/health`
  (covers `/health` and `/health/deep`; the rest of the site, including `/ws`
  and the play client, stays public).
- **Policies** -- mirror the other SkyPhusion apps: a `non_identity` "Health
  Checks" policy admitting the shared `kuma-monitor` service token (so Uptime
  Kuma can poll non-interactively with `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers), plus an `allow` email policy for the
  operators (so a browser hit prompts for SSO).
- **Monitoring** -- point a Kuma monitor at `https://hollow.skyphusion.org/health`
  (60s) and `/health/deep` (5min), sending the `kuma-monitor` token headers.

Access is configured via the Cloudflare API (account-level Zero Trust), not in
`wrangler.jsonc`; it sits in front of the Worker, so the Worker code is
unchanged.
