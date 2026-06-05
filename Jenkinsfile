// CI/CD for The Hollow Grid.
//
// On every push: install, typecheck, and run the smoke suite against a real
// local `wrangler dev` (both worlds + the hub). On main, after those pass, deploy
// to Cloudflare (hub, then The Hollow Grid, then Dustfall).
//
// Requirements on the Jenkins agent / controller:
//   - Node 24+ and npm on PATH (the smoke suite uses the global WebSocket).
//   - A "Secret text" credential with id 'cloudflare-api-token' holding a
//     Cloudflare API token scoped to deploy Workers + edit the skyphusion.org
//     zone (Workers Scripts: Edit, Workers Routes: Edit, DNS: Edit, SSL: Edit).
//     wrangler reads it from $CLOUDFLARE_API_TOKEN; this replaces interactive
//     `wrangler login` for headless CI.
pipeline {
  agent any

  options {
    timestamps()
    timeout(time: 25, unit: 'MINUTES')
    disableConcurrentBuilds()
  }

  environment {
    CI = 'true'
    CLOUDFLARE_API_TOKEN = credentials('cloudflare-api-token')
  }

  stages {
    stage('Install') {
      steps {
        sh 'node --version && npm --version'
        sh 'npm ci'
      }
    }

    stage('Typecheck') {
      steps {
        sh 'npm run typecheck'
      }
    }

    stage('Smoke') {
      steps {
        // Start both worlds + hub, wait for the ports, run the smoke suite.
        //
        // CRITICAL: each world runs under its OWN process group via `setsid`, and
        // teardown kills exactly those groups (`kill -- -$PGID`). We do NOT use
        // `npm run dev` (its kill-0 once SIGTERM'd the Jenkins controller) and we
        // do NOT `pkill wrangler` (rude on a shared controller). WORLD_URL is
        // overridden back to localhost so the registry/travel assertions hold.
        sh '''
          set -e
          rm -rf .wrangler/state
          setsid ./node_modules/.bin/wrangler dev -c wrangler.jsonc -c grid-hub/wrangler.jsonc --var WORLD_URL:ws://localhost:8787/ws > dev-hollow.log 2>&1 &
          P1=$!
          setsid ./node_modules/.bin/wrangler dev -c worlds/dustfall.jsonc --var WORLD_URL:ws://localhost:8788/ws > dev-dustfall.log 2>&1 &
          P2=$!
          trap 'kill -- -$P1 -$P2 2>/dev/null || true' EXIT
          # Wait (up to ~90s) for Dustfall's port, using node (no extra deps).
          node -e '
            const net = require("net");
            const up = () => new Promise((res) => {
              const s = net.connect(8788, "127.0.0.1");
              s.on("connect", () => { s.destroy(); res(true); });
              s.on("error", () => res(false));
            });
            (async () => {
              for (let i = 0; i < 90; i++) { if (await up()) process.exit(0); await new Promise(r => setTimeout(r, 1000)); }
              console.error("dev servers did not come up in time"); process.exit(1);
            })();
          '
          npm run smoke
        '''
      }
      post {
        always {
          archiveArtifacts artifacts: 'dev-hollow.log,dev-dustfall.log', allowEmptyArchive: true
        }
      }
    }

    stage('Deploy') {
      when { branch 'main' }
      steps {
        // hub first (the worlds bind it), then the two worlds. npm run deploy
        // chains them in that order. wrangler authenticates via CLOUDFLARE_API_TOKEN.
        sh 'npm run deploy'
      }
    }
  }

  post {
    success {
      echo 'Pipeline green. (Deploy runs only on main.)'
    }
  }
}
