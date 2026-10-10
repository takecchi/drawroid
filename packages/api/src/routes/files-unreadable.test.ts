// 原寸はあるが読めない画像の縮小版を求められたとき、サーバの不具合（500）にせず、データの問題（422）として返すこと
import { rm } from 'node:fs/promises';

import { STUB_PNG } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createAutoJob, request, setup, signatureOnly } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await rm(ctx.root, { recursive: true, force: true });
});

async function expectUnreadable(res: Response) {
  expect(res.status).toBe(422);
  const { error } = (await res.json()) as { error: { kind: string; message: string } };
  expect(error.kind).toBe('invalid_file');
  expect(error.message).toContain('読めない');
}

describe('the preview of an image that cannot be read', () => {
  it('is answered as an unreadable file for a reference image', async () => {
    const job = await createAutoJob(ctx.store);
    const ref = await ctx.store.addReference(
      job.jobId,
      { data: signatureOnly('png'), mediaType: 'image/png' },
      new Date(),
    );

    await expectUnreadable(
      await ctx.api.request(`/files/jobs/${job.jobId}/refs/${ref.refId}.preview.webp`),
    );
  });

  it('is answered as an unreadable file for a generated image', async () => {
    const job = await createAutoJob(ctx.store);
    await ctx.store.writeGeneration(job.jobId, 1, request, {
      images: [{ png: signatureOnly('png'), seed: 1, metadata: {} }],
      metadata: {},
    });

    await expectUnreadable(
      await ctx.api.request(`/files/jobs/${job.jobId}/iterations/1/images/0.preview.webp`),
    );
  });

  it('still answers 404 for a generated image that does not exist', async () => {
    const job = await createAutoJob(ctx.store);

    const res = await ctx.api.request(
      `/files/jobs/${job.jobId}/iterations/1/images/0.preview.webp`,
    );

    expect(res.status).toBe(404);
  });
});

// 読めない画像だけを 422 にする: 置き場所の失敗まで「画像が読めない」と言うと、権限や空きの問題が画像の問題に見えるため
describe('the preview, when the data directory cannot be read', () => {
  async function expectStorageFailure(res: Response) {
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: { kind: string } };
    expect(error.kind).toBe('storage_failed');
  }

  function failStorage() {
    const failure = Object.assign(new Error("EACCES: open '/data/x.webp'"), {
      code: 'EACCES',
      path: '/data/x.webp',
    });
    vi.spyOn(ctx.store, 'loadPreview').mockRejectedValue(failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => {
      logged.mockRestore();
      vi.restoreAllMocks();
    });
  }

  it('is answered as a storage failure for a reference image', async () => {
    const job = await createAutoJob(ctx.store);
    const ref = await ctx.store.addReference(
      job.jobId,
      { data: STUB_PNG, mediaType: 'image/png' },
      new Date(),
    );
    failStorage();

    await expectStorageFailure(
      await ctx.api.request(`/files/jobs/${job.jobId}/refs/${ref.refId}.preview.webp`),
    );
  });

  it('is answered as a storage failure for a generated image', async () => {
    const job = await createAutoJob(ctx.store);
    await ctx.store.writeGeneration(job.jobId, 1, request, {
      images: [{ png: STUB_PNG, seed: 1, metadata: {} }],
      metadata: {},
    });
    failStorage();

    await expectStorageFailure(
      await ctx.api.request(`/files/jobs/${job.jobId}/iterations/1/images/0.preview.webp`),
    );
  });
});
