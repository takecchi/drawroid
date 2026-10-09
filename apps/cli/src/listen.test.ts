import { fileURLToPath } from 'node:url';

import { DEFAULT_BUDGET, type JobStore } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, HOST, listen } from './listen.js';

const webRoot = fileURLToPath(new URL('./test-fixtures/web', import.meta.url));
const deps = {
  // ここで確かめる経路は store を使わない
  store: {} as JobStore,
  queue: { kick: () => undefined, stop: async () => undefined },
  budget: DEFAULT_BUDGET,
  llmSettings: { read: async () => undefined, write: async () => undefined },
  env: {},
};

describe('listen', () => {
  it('listens on 127.0.0.1 only', async () => {
    const { server, address } = await listen({ port: 0, webRoot, deps });
    try {
      expect(address.address).toBe('127.0.0.1');
      const res = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('defaults to a port that does not collide with Forge / A1111 or ComfyUI', () => {
    expect(HOST).toBe('127.0.0.1');
    expect([7860, 8188]).not.toContain(DEFAULT_PORT);
  });

  it('rejects when the port is already taken', async () => {
    const first = await listen({ port: 0, webRoot, deps });
    try {
      await expect(listen({ port: first.address.port, webRoot, deps })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      first.server.close();
    }
  });
});
