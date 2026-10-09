// 添えた参照画像の縮小版を返す口が、本当に縮小して返すこと（#67 の 59-05）。
// 既存の試験の画像は極小で、縮小しなくても見分けがつかなかった
import { rm } from 'node:fs/promises';

import { DEFAULT_BUDGET } from '@drawroid/core';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutoJob, png, setup } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await rm(ctx.root, { recursive: true, force: true });
});

describe('the preview of a reference image', () => {
  it('serves a webp whose long edge is reduced to the image budget', async () => {
    const job = await createAutoJob(ctx.store);
    const ref = await ctx.store.addReference(
      job.jobId,
      { data: await png(1600, 900), mediaType: 'image/png' },
      new Date(),
    );

    const res = await ctx.api.request(`/files/jobs/${job.jobId}/refs/${ref.refId}.preview.webp`);
    expect(res.status).toBe(200);
    const { width, height, format } = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(format).toBe('webp');
    expect(Math.max(width, height)).toBe(DEFAULT_BUDGET.imageLongEdge);
  });
});
