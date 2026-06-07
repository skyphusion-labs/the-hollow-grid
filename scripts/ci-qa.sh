#!/usr/bin/env bash
# In-container QA for The Hollow Grid CI: install, typecheck, and run the smoke
# suite against a real `wrangler dev` of BOTH worlds + the hub (so the federation
# phase is exercised, not skipped).
#
# This runs INSIDE a throwaway `docker run --rm` container (see the Jenkinsfile),
# which is the whole point: the container is the process boundary, so the two
# background `wrangler dev` servers die with it on exit -- no setsid/process-group
# teardown, and no way for a stray kill to reach the Jenkins controller (the bug
# that once SIGTERM'd the JVM). Run it by hand the same way to reproduce CI:
#
#   docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI=true \
#     -v "$PWD":/app -w /app node:24 bash scripts/ci-qa.sh
set -euo pipefail

export CI=true WRANGLER_SEND_METRICS=false
: "${HOME:=/tmp}"; export HOME

echo "=== versions ==="
node --version
npm --version

echo "=== install ==="
npm ci --no-audit --no-fund

echo "=== typecheck ==="
npm run typecheck

echo "=== start both worlds + hub ==="
# Clear every world's local dev state so each CI run starts from a clean Grid
# (stale Durable Object state between runs is the classic cause of smoke drift).
rm -rf .wrangler grid-hub/.wrangler worlds/.wrangler
# WORLD_URL is forced back to localhost so the registry/travel assertions in the
# smoke suite hold against the local dev servers.
./node_modules/.bin/wrangler dev -c wrangler.jsonc -c grid-hub/wrangler.jsonc \
  --var WORLD_URL:ws://localhost:8787/ws > dev-hollow.log 2>&1 &
./node_modules/.bin/wrangler dev -c worlds/dustfall.jsonc \
  --var WORLD_URL:ws://localhost:8788/ws > dev-dustfall.log 2>&1 &

echo "=== wait for Dustfall's port (up to ~120s) ==="
# Dustfall (8788) is the later/dependent world; once it answers, both are up.
node -e '
  const net = require("net");
  const up = () => new Promise((res) => {
    const s = net.connect(8788, "127.0.0.1");
    s.on("connect", () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
  });
  (async () => {
    for (let i = 0; i < 120; i++) { if (await up()) process.exit(0); await new Promise(r => setTimeout(r, 1000)); }
    console.error("dev servers did not come up in time"); process.exit(1);
  })();
'

echo "=== smoke ==="
npm run smoke
