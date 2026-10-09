import { readFile, rm } from 'node:fs/promises';

import { DEFAULT_BUDGETS, resolveBudgets, type Budgets } from '@drawroid/core';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { png, request, setup } from '../test-support.js';

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
const putBudgets = (body: unknown) => send('PUT', '/settings/budgets', body);

type View = { overrides: unknown; effective: Budgets; defaults: Budgets };

async function submitJob(): Promise<string> {
  const res = await send('POST', '/jobs/auto', { request: '夕暮れの海辺の少女' });
  expect(res.status).toBe(202);
  return ((await res.json()) as { jobId: string }).jobId;
}

const jobJsonBudgets = async (jobId: string) =>
  (JSON.parse(await readFile(ctx.paths.jobFiles(jobId).spec, 'utf8')) as { budgets?: Budgets })
    .budgets;

describe('/settings/budgets', () => {
  it('shows the defaults when nothing was written', async () => {
    const res = await send('GET', '/settings/budgets');

    expect(res.status).toBe(200);
    expect((await res.json()) as View).toEqual({
      overrides: {},
      effective: DEFAULT_BUDGETS,
      defaults: DEFAULT_BUDGETS,
      invalid: [],
    });
  });

  it('returns what was written with the effective values, and reads it back', async () => {
    const put = await putBudgets({ imageLongEdge: 256, distill: { output: { body: 40 } } });

    expect(put.status).toBe(200);
    const view = (await put.json()) as View;
    expect(view.overrides).toEqual({ imageLongEdge: 256, distill: { output: { body: 40 } } });
    expect(view.effective).toEqual(
      resolveBudgets({ imageLongEdge: 256, distill: { output: { body: 40 } } }),
    );
    expect(view.defaults).toEqual(DEFAULT_BUDGETS);
    expect(((await (await send('GET', '/settings/budgets')).json()) as View).effective).toEqual(
      view.effective,
    );
  });

  it.each([
    ['an image long edge of 0', { imageLongEdge: 0 }],
    ['an image long edge of 10000', { imageLongEdge: 10_000 }],
    ['9 images per judge', { imagesPerJudge: 9 }],
    ['an unknown key', { nope: 1 }],
  ])('answers 400 for %s and keeps the stored budgets', async (_name, body) => {
    await putBudgets({ imageLongEdge: 256 });

    const res = await putBudgets(body);

    expect(res.status).toBe(400);
    expect(((await (await send('GET', '/settings/budgets')).json()) as View).overrides).toEqual({
      imageLongEdge: 256,
    });
  });
});

describe('budgets written to job.json', () => {
  it('copies the budgets resolved at submission', async () => {
    await putBudgets({ imageLongEdge: 256, text: { prompt: 300 } });

    const jobId = await submitJob();

    expect(await jobJsonBudgets(jobId)).toEqual(
      resolveBudgets({ imageLongEdge: 256, text: { prompt: 300 } }),
    );
  });

  it('does not change the budgets of a job that was already submitted when the settings change', async () => {
    await putBudgets({ imageLongEdge: 256 });
    const jobId = await submitJob();

    await putBudgets({ imageLongEdge: 1024, imagesPerJudge: 2 });

    expect((await jobJsonBudgets(jobId))?.imageLongEdge).toBe(256);
    expect((await jobJsonBudgets(jobId))?.imagesPerJudge).toBe(DEFAULT_BUDGETS.imagesPerJudge);
    const next = await submitJob();
    expect((await jobJsonBudgets(next))?.imageLongEdge).toBe(1024);
  });
});

describe('preview long edge', () => {
  const webpEdge = async (res: Response) => {
    expect(res.status).toBe(200);
    const { width = 0, height = 0 } = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    return Math.max(width, height);
  };

  async function jobWithImage(edge: number | undefined) {
    const spec = await ctx.store.createJob(
      {
        kind: 'auto',
        request: '夕暮れの海辺の少女',
        stopConditions: { aiJudgement: true, maxIterations: 5 },
        batchSize: 1,
        ...(edge === undefined ? {} : { budgets: resolveBudgets({ imageLongEdge: edge }) }),
      },
      { status: 'queued' },
      new Date(),
    );
    await ctx.store.writeGeneration(spec.jobId, 1, request, {
      images: [{ png: await png(1024, 768), seed: 7, metadata: {} }],
      metadata: {},
    });
    return spec.jobId;
  }

  it('builds the image preview at the long edge of the job, not of the current settings', async () => {
    const jobId = await jobWithImage(256);
    await putBudgets({ imageLongEdge: 1024 });

    const res = await ctx.api.request(`/files/jobs/${jobId}/iterations/1/images/0.preview.webp`);

    expect(await webpEdge(res)).toBe(256);
  });

  it('builds the reference preview at the long edge of the job', async () => {
    const jobId = await jobWithImage(256);
    const ref = await ctx.store.addReference(
      jobId,
      { data: await png(1600, 900), mediaType: 'image/png' },
      new Date(),
    );
    await putBudgets({ imageLongEdge: 1024 });

    const res = await ctx.api.request(`/files/jobs/${jobId}/refs/${ref.refId}.preview.webp`);

    expect(await webpEdge(res)).toBe(256);
  });

  it('uses the default long edge for a job without budgets', async () => {
    const jobId = await jobWithImage(undefined);
    await putBudgets({ imageLongEdge: 256 });

    const res = await ctx.api.request(`/files/jobs/${jobId}/iterations/1/images/0.preview.webp`);

    expect(await webpEdge(res)).toBe(DEFAULT_BUDGETS.imageLongEdge);
  });
});
