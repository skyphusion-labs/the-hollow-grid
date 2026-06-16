import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      // 1. Core main option must be a flat string path pointing to the root config
      main: './wrangler.jsonc',
      
      // 2. Pass the multi-worker definitions down to the environment manager
      auxiliaryWorkers: [
        {
          configPath: './grid-hub/wrangler.jsonc'
        },
        {
          configPath: './worlds/dustfall.jsonc'
        }
      ],

      // 3. Forcibly inject the service name mapping down to the miniflare instance execution layer
      miniflare: {
        services: {
          'grid-hub': {
            workerName: 'grid-hub',
            entrypoint: 'GridHubService'
          }
        }
      }
    })
  ]
});
