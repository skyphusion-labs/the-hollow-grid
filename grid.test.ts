import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const WORLD = (globalThis as any).WORLD;
const GRID = (globalThis as any).GRID;

describe('The Hollow Grid - Durable Object State Tests', () => {
  it('should initialize stub and mutate isolated storage states', async () => {
    // Access the binding directly from the resolved meta pool
    const id = env.WORLD.newUniqueId();
    const stub = env.WORLD.get(id);

    await runInDurableObject(stub, async (instance, state: DurableObjectState) => {
      await state.storage.put('player:conrad:coords', { x: 4, y: 12 });
      const hasKey = await state.storage.get('player:conrad:coords');
      expect(hasKey).toEqual({ x: 4, y: 12 });
    });
  });

  it('should process network fetch calls to the grid router', async () => {
    // Triggers your federated service mesh microservice routing
    const response = await env.GRID.fetch('http://localhost/api/world-info');
    expect(response.status).toBe(200);
  });
});
