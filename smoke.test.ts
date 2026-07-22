import { describe, it } from 'vitest';

describe('MUD Engine Smoke Suite', () => {
  it(
    'should execute smoke script successfully',
    async () => {
      // Dynamically executes your exact script inside the Istanbul coverage wrapper
      await import('./smoke.mjs');
    },
    600_000,
  );
});
