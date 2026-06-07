// CI/CD for The Hollow Grid.
//
// Every stage that builds, tests, or deploys runs INSIDE a throwaway
// `docker run --rm node:24` container on the Jenkins agent. This buys two things:
//   1. Isolation. The smoke stage spins up two `wrangler dev` servers; the
//      container is the process boundary, so they die with it on exit. There is
//      no setsid/process-group teardown and no way for a stray kill to reach the
//      Jenkins controller (an earlier `npm run dev` kill-0 once SIGTERM'd the JVM).
//   2. A pinned toolchain. The container brings Node 24; the agent's own Node
//      version no longer matters.
//
// Requirements on the Jenkins agent:
//   - Docker, with the `jenkins` user in the `docker` group (so it can `docker run`).
//   - A "Secret text" credential id 'cloudflare-api-token' holding a Cloudflare
//     API token scoped to deploy Workers + edit the skyphusion.org zone (Workers
//     Scripts: Edit, Workers Routes: Edit, DNS: Edit, SSL: Edit). It is passed
//     into the deploy container as $CLOUDFLARE_API_TOKEN (wrangler reads it,
//     replacing interactive `wrangler login`).
//
// Containers run as the agent's uid:gid with HOME=/tmp so workspace files
// (node_modules, .wrangler, logs) stay agent-owned and cleanable, never root.
pipeline {
  agent any

  options {
    timestamps()
    timeout(time: 30, unit: 'MINUTES')
    disableConcurrentBuilds()
  }

  environment {
    CLOUDFLARE_API_TOKEN = credentials('cloudflare-api-token')
  }

  stages {
    stage('Build, typecheck & smoke') {
      steps {
        // install -> typecheck -> both worlds + hub under wrangler dev -> smoke,
        // all inside one container (see scripts/ci-qa.sh). Single-quoted so the
        // shell (not Groovy) expands $(id -u)/$WORKSPACE at runtime.
        sh '''
          docker run --rm \
            -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI=true \
            -v "$WORKSPACE":/app -w /app \
            node:24 bash scripts/ci-qa.sh
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
        // chains them in that order; wrangler authenticates via CLOUDFLARE_API_TOKEN
        // (passed through to the container with -e).
        sh '''
          docker run --rm \
            -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI=true \
            -e CLOUDFLARE_API_TOKEN \
            -v "$WORKSPACE":/app -w /app \
            node:24 bash -c "npm ci --no-audit --no-fund && npm run deploy"
        '''
      }
    }
  }

  post {
    success {
      echo 'Pipeline green. (Deploy runs only on main.)'
    }
  }
}
