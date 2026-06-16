import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const env = (import.meta as any).env;

describe('The Hollow Grid - Durable Object State Tests', () => {
  it('should initialize stub and mutate isolated storage states', async () => {
    const id = env.WORLD.newUniqueId();
    const stub = env.WORLD.get(id);

    await runInDurableObject(stub, async (instance, state: DurableObjectState) => {
      await state.storage.put('player:conrad:coords', { x: 4, y: 12 });
      const hasKey = await state.storage.get('player:conrad:coords');
      expect(hasKey).toEqual({ x: 4, y: 12 });
    });
  });

  it('should process network fetch calls to the grid router', async () => {
    const response = await env.GRID.fetch('http://localhost/api/world-info');
    expect(response.status).toBe(200);
  });
});
