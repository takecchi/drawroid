// selectionsRoutes の TSDoc「手動のジョブ・自動のジョブのどちらにも付けられる」の、手動のジョブの側（#67 の 31-13）
import { rm } from 'node:fs/promises';

import type { GenerationResult } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { request, setup } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await rm(ctx.root, { recursive: true, force: true });
});

const oneImage: GenerationResult = {
  images: [{ png: Uint8Array.of(137, 80, 78, 71, 0), seed: 0, metadata: {} }],
  metadata: {},
};

describe('selections on a manual job', () => {
  it('marks an image of a manual job as a favorite and reads it back', async () => {
    const spec = await ctx.store.createJob(
      { kind: 'manual', request },
      { status: 'queued' },
      new Date('2026-10-09T00:00:00Z'),
    );
    await ctx.store.writeGeneration(spec.jobId, 1, request, oneImage);

    const res = await ctx.api.request(`/jobs/${spec.jobId}/selections/1-0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'favorite' }),
    });
    expect(res.status).toBe(200);
    const listed = await ctx.api.request(`/jobs/${spec.jobId}/selections`);
    expect(await listed.json()).toMatchObject({
      selections: [{ imageKey: '1-0', verdict: 'favorite' }],
    });
  });
});
