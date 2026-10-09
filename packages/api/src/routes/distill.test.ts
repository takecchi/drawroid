import { rm } from 'node:fs/promises';

import type { DistillEntry } from '@drawroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createAutoJob, setup } from '../test-support.js';

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const pref = (body: string) => ({ body, tags: ['手'], scope: 'always' as const });

const ENTRY: DistillEntry = {
  kind: 'stopped',
  at: '2026-10-10T05:00:00.000Z',
  callId: 'call-secret-ish',
  shown: { interventions: ['口出しの原文'], selections: ['1-0'], memory: ['m-1'] },
  budgetNotes: [{ kind: 'dropped', section: 'memory', reason: '予算' }],
  applied: [
    { op: 'add', id: 'm-2', after: pref('指の崩れは許容しない') },
    { op: 'edit', id: 'm-1', before: pref('彩度は普通'), after: pref('彩度は控えめ') },
  ],
  skipped: [{ operation: { op: 'add', ...pref('重複') }, reason: '同じ項目がある' }],
};

describe('GET /jobs/:jobId/distill', () => {
  it('returns what the job taught, only the fields the screen needs', async () => {
    const reads: string[] = [];
    const ctx = await setup({
      distillLog: {
        read: async (jobId) => {
          reads.push(jobId);
          return [ENTRY, { ...ENTRY, kind: 'reselection', applied: [], failure: '形が合わない' }];
        },
      },
    });
    root = ctx.root;
    const { jobId } = await createAutoJob(ctx.store);

    const res = await ctx.api.request(`/jobs/${jobId}/distill`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [
        {
          kind: 'stopped',
          at: '2026-10-10T05:00:00.000Z',
          added: [{ id: 'm-2', body: '指の崩れは許容しない' }],
          edited: [{ id: 'm-1', before: '彩度は普通', after: '彩度は控えめ' }],
        },
        {
          kind: 'reselection',
          at: '2026-10-10T05:00:00.000Z',
          added: [],
          edited: [],
          failure: '形が合わない',
        },
      ],
    });
    expect(reads).toEqual([jobId]);
  });

  it('answers no entries when the job has not been distilled, or when there is no log', async () => {
    const ctx = await setup({ distillLog: { read: async () => [] } });
    root = ctx.root;
    const { jobId } = await createAutoJob(ctx.store);
    expect(await (await ctx.api.request(`/jobs/${jobId}/distill`)).json()).toEqual({ entries: [] });

    const without = await setup();
    const { jobId: other } = await createAutoJob(without.store);
    expect(await (await without.api.request(`/jobs/${other}/distill`)).json()).toEqual({
      entries: [],
    });
    await rm(without.root, { recursive: true, force: true });
  });

  it('refuses a job that does not exist, without reading anything', async () => {
    const reads: string[] = [];
    const ctx = await setup({
      distillLog: {
        read: async (jobId) => {
          reads.push(jobId);
          return [];
        },
      },
    });
    root = ctx.root;

    const res = await ctx.api.request('/jobs/../../etc/distill');
    const missing = await ctx.api.request('/jobs/20261010-000000-none/distill');

    expect(res.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(reads).toEqual([]);
  });
});
