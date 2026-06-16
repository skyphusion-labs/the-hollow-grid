import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { 
        configPath: './wrangler.jsonc',
        
        services: [
          {
            binding: 'GRID',
            service: 'grid-hub',
            configPath: './grid-hub/wrangler.jsonc'
          },
          {
            service: 'dustfall',
            configPath: './worlds/dustfall.jsonc'
          }
        ]
      },
      isolatedStorage: true
    })
  ],
  test: {
    globals: true,
    coverage: {
      provider: 'istanbul',
      reporter: ['cobertura'],
      reportsDirectory: './coverage'
    }
  }
});
