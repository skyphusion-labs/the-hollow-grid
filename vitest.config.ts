import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      configPath: './wrangler.jsonc'
    })
  ],
  test: {
    name: 'the-hollow-grid',
    pool: 'workers',
    
    workers: {
      isolatedStorage: true,
      auxiliaryWorkers: [
        {
          name: 'grid-hub',
          configPath: './grid-hub/wrangler.jsonc'
        },
        {
          name: 'dustfall',
          configPath: './worlds/dustfall.jsonc'
        }
      ]
    },
    
    globals: true,
    coverage: {
      provider: 'istanbul',
      reporter: ['cobertura'],
      reportsDirectory: './coverage'
    }
  }
});
