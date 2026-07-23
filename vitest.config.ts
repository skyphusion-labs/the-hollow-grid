import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 600_000,
    coverage: {  
      provider: 'istanbul',
      reporter: ['cobertura'],
      reportsDirectory: './coverage'
    }
  }
});
