import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import type { DoctorReport } from '../deps.js';
import { setup } from '../test-support.js';

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const REPORT: DoctorReport = {
  sections: [
    { title: '設定ファイル', items: [{ ok: true, what: '読める' }] },
    {
      title: 'LLM',
      items: [{ ok: false, what: 'まだ設定していない', todo: 'LLM の設定で入れる' }],
    },
  ],
  lacking: 1,
};

describe('POST /doctor', () => {
  it('runs the check and returns the report as it is', async () => {
    let runs = 0;
    const ctx = await setup({
      doctor: {
        run: async () => {
          runs++;
          return REPORT;
        },
      },
    });
    root = ctx.root;

    const res = await ctx.api.request('/doctor', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: REPORT });
    expect(runs).toBe(1);
  });

  it('refuses with 409 when this launch cannot check', async () => {
    const ctx = await setup();
    root = ctx.root;

    const res = await ctx.api.request('/doctor', { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { kind: 'unavailable' } });
  });
});
