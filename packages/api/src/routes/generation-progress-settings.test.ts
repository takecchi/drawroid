import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setup } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await rm(ctx.root, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown) =>
  ctx.api.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('/settings/generation-progress', () => {
  it('is disabled by default', async () => {
    const res = await send('GET', '/settings/generation-progress');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ includePreview: false });
  });

  it('keeps what was put', async () => {
    const put = await send('PUT', '/settings/generation-progress', { includePreview: true });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ includePreview: true });

    const res = await send('GET', '/settings/generation-progress');
    expect(await res.json()).toEqual({ includePreview: true });
  });

  it.each([
    ['a non-boolean', { includePreview: 'yes' }],
    ['a missing field', {}],
    ['an unknown field', { includePreview: true, extra: 1 }],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await send('PUT', '/settings/generation-progress', body);

    expect(res.status).toBe(400);
    expect((await send('GET', '/settings/generation-progress')).status).toBe(200);
    expect(await (await send('GET', '/settings/generation-progress')).json()).toEqual({
      includePreview: false,
    });
  });
});

describe('/jobs/:jobId/progress-preview', () => {
  const preview = { data: new Uint8Array([9, 8, 7]), mediaType: 'image/jpeg' as const };

  async function submitJob(): Promise<string> {
    const res = await send('POST', '/jobs/auto', { request: '夕暮れの海辺の少女' });
    expect(res.status).toBe(202);
    return ((await res.json()) as { jobId: string }).jobId;
  }

  it('is 404 while the setting is disabled', async () => {
    const jobId = await submitJob();
    ctx.progressPreviews.set(jobId, preview);

    expect((await send('GET', `/jobs/${jobId}/progress-preview`)).status).toBe(404);
  });

  it('returns the held image with its media type once enabled', async () => {
    const jobId = await submitJob();
    ctx.progressPreviews.set(jobId, preview);
    await ctx.generationProgressSettings.write({ includePreview: true });

    const res = await send('GET', `/jobs/${jobId}/progress-preview`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(preview.data);
  });

  it('is 404 when the held image belongs to another job', async () => {
    const jobId = await submitJob();
    ctx.progressPreviews.set('someone-else', preview);
    await ctx.generationProgressSettings.write({ includePreview: true });

    expect((await send('GET', `/jobs/${jobId}/progress-preview`)).status).toBe(404);
  });

  it('is 404 when nothing is held', async () => {
    const jobId = await submitJob();
    await ctx.generationProgressSettings.write({ includePreview: true });

    expect((await send('GET', `/jobs/${jobId}/progress-preview`)).status).toBe(404);
  });

  it('is 404 for an unknown job even if an image is held under that id', async () => {
    ctx.progressPreviews.set('20260101-000000-zzzz', preview);
    await ctx.generationProgressSettings.write({ includePreview: true });

    expect((await send('GET', '/jobs/20260101-000000-zzzz/progress-preview')).status).toBe(404);
  });
});
