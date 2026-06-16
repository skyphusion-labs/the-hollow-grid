import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      
      workers: [
        {
          name: 'grid-hub', 
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
