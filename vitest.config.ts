import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      // 1. Explicitly configure the primary root worker
      main: {
        configPath: './wrangler.jsonc',
      },
      
      // 2. Register child services and ensure their internal service name maps 1:1 👇
      auxiliaryWorkers: [
        {
          name: 'grid-hub', // Maps directly to "service": "grid-hub" in your root wrangler.jsonc
          configPath: './grid-hub/wrangler.jsonc'
        },
        {
          name: 'dustfall',
          configPath: './worlds/dustfall.jsonc'
        }
      ]
    })
  ]
});
