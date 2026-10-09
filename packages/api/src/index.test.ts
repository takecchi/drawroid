import { DEFAULT_BUDGET, type JobStore } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { createApi } from './index.js';

const api = createApi({
  // 健康確認の経路は store を使わない
  store: {} as JobStore,
  queue: { kick: () => undefined, stop: async () => undefined },
  budget: DEFAULT_BUDGET,
  llmSettings: { read: async () => undefined, write: async () => undefined },
  env: {},
});

describe('createApi', () => {
  it('answers the health check', async () => {
    const res = await api.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
