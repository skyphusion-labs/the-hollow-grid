import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      configPath: './wrangler.jsonc',
      auxiliaryWorkers: [
        { configPath: './grid-hub/wrangler.jsonc' },
        { configPath: './worlds/dustfall.jsonc' }
      ]
    })
  ],
  test: {
    name: 'the-hollow-grid', 
    pool: 'workers',
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' }
      }
    },
    coverage: {
      provider: 'istanbul',
      reporter: ['cobertura'],
      reportsDirectory: './coverage'
    }
  }
});
