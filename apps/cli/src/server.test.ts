import { fileURLToPath } from 'node:url';

import { DEFAULT_BUDGET, type JobStore } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './server.js';

const webRoot = fileURLToPath(new URL('./test-fixtures/web', import.meta.url));
const deps = {
  // ここで確かめる経路は store を使わない
  store: {} as JobStore,
  queue: { kick: () => undefined, stop: async () => undefined },
  budget: DEFAULT_BUDGET,
  llmSettings: { read: async () => undefined, write: async () => undefined },
  env: {},
};
const app = createApp({ webRoot, deps });

describe('createApp', () => {
  it('serves the API under /api', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers unknown API paths with a JSON 404 instead of the Web UI', async () => {
    const res = await app.request('/api/no-such-route');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('serves the Web UI at the root', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture index');
  });

  it('serves built assets as files', async () => {
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture = true');
  });

  it('falls back to the Web UI for client-side routes', async () => {
    const res = await app.request('/jobs/20261009-153012-k3f9');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture index');
  });
});
