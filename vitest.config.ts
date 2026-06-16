import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; 

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Use configPath to load settings, leaving "main" to auto-resolve from wrangler
      configPath: './wrangler.jsonc',
      
      auxiliaryWorkers: [
        { configPath: './grid-hub/wrangler.jsonc' },
        { configPath: './worlds/dustfall.jsonc' }
      ]
    })
  ],
  test: {
    coverage: {
      provider: 'istanbul', // Bypasses node:inspector completely
      reporter: ['cobertura'],
      reportsDirectory: './coverage'
    }
  }
});
