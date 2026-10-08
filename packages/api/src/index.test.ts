import { describe, expect, it } from 'vitest';

import { createApi } from './index.js';

describe('createApi', () => {
  it('answers the health check', async () => {
    const res = await createApi().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
