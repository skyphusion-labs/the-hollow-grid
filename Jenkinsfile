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
        // Start the full federation (primary :8787 + Dustfall :8788 + hub) in the
        // background, wait for both world ports to accept connections, then run
        // the smoke suite against them. The dev scripts override WORLD_URL back to
        // localhost so the registry/travel assertions hold.
        sh '''
          set -e
          rm -rf .wrangler/state
          npm run dev > dev.log 2>&1 &
          echo $! > .devpid
          # Wait (up to ~90s) for Dustfall's port to come up, using node so we
          # depend on nothing beyond what the project already needs.
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
          // Tear down the dev servers regardless of smoke result, and surface logs
          // on failure for debugging.
          sh 'pkill -f "[w]rangler" 2>/dev/null || true; rm -f .devpid'
          archiveArtifacts artifacts: 'dev.log', allowEmptyArchive: true
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
    always {
      sh 'pkill -f "[w]rangler" 2>/dev/null || true'
    }
    success {
      echo 'Pipeline green. (Deploy runs only on main.)'
    }
  }
}
