#!/usr/bin/env bash
# Run the whole federation locally.
#
# wrangler dev serves only the FIRST config in a multi-config invocation on a
# port; the rest are auxiliary (reachable via service bindings, not their own
# port). Two worlds both need to accept player connections, so each gets its own
# wrangler process: the primary world + the hub in one, the second world
# (Dustfall) in the other. Dustfall's GRID service binding finds the single hub
# through wrangler's local dev registry, so both worlds share one Grid -- the
# same shape as two separate production deployments binding one backend.
#
# Primary world: ws://localhost:8787/ws   Dustfall: ws://localhost:8788/ws
# Ctrl-C stops both. (Run a single world instead with `npm run dev:solo`.)
set -euo pipefail

# WORLD_URL in the configs is the PRODUCTION (wss://...skyphusion.org) address;
# override it back to the local dev ports here so the registry/travel handoff
# points at the running dev servers (and smoke's localhost assertions hold).
wrangler dev -c wrangler.jsonc -c grid-hub/wrangler.jsonc --var WORLD_URL:ws://localhost:8787/ws &
P1=$!
wrangler dev -c worlds/dustfall.jsonc --var WORLD_URL:ws://localhost:8788/ws &
P2=$!

# Kill ONLY our two child processes on exit -- never `kill 0`, which signals the
# whole process group and, under a CI runner, can take down the parent (it once
# SIGTERM'd the Jenkins controller). wrangler reaps its own workerd on SIGTERM.
trap 'kill "$P1" "$P2" 2>/dev/null || true' INT TERM EXIT
wait
