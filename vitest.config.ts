import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      
      auxiliaryWorkers: [
        {
          name: 'grid-hub',
          configPath: './grid-hub/wrangler.jsonc'
        },
        {
          name: 'dustfall',
          configPath: './worlds/dustfall.jsonc'
        }
      ],

      // CONRAD YOU NEED TO FORCE THE UNSAFE BINDING HERE BECAUSE OF THE CONFIGURATION ISOLATION
      config: {
        unsafe: {
          bindings: [
            {
              name: 'GRID',
              type: 'service',
              service: 'grid-hub',
              entrypoint: 'GridHubService'
            }
          ]
        }
      }
    })
  ]
});
