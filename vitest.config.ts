import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
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
