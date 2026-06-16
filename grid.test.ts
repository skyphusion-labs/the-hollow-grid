import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
// Replace this with the actual path to your Hub or World Durable Object class
import { GridHub } from './grid-hub/index.js'; 

describe('The Hollow Grid - Durable Object State Tests', () => {
  it('should initialize stub and mutate isolated storage states', async () => {
    // 1. Generate a mock ID from your Wrangler Namespace configuration
    const id = env.GRID_HUB_NAMESPACE.newUniqueId();
    const stub = env.GRID_HUB_NAMESPACE.get(id);

    // 2. Intercept and inspect inside the active Durable Object context
    await runInDurableObject(stub, async (instance: GridHub, state: DurableObjectState) => {
      // Seed a testing position vector onto your Durable Object's storage
      await state.storage.put('player:conrad:coords', { x: 4, y: 12 });
      
      // Directly check the state evaluation inside the object instance
      const hasKey = await state.storage.get('player:conrad:coords');
      expect(hasKey).toEqual({ x: 4, y: 12 });
    });
  });

  it('should process network fetch calls to the grid router', async () => {
    const id = env.GRID_HUB_NAMESPACE.newUniqueId();
    const stub = env.GRID_HUB_NAMESPACE.get(id);

    // Send a standard HTTP frame directly down the DO pipeline
    const response = await stub.fetch('http://localhost/api/world-info');
    
    expect(response.status).toBe(200);
  });
});
