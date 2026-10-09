import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BUDGET,
  generationRequestSchema,
  ManualGenerationRunner,
  type GenerationResult,
} from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { FsJobStore } from '@drawroid/storage-fs';
import { hc } from 'hono/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi, type AppType } from '../index.js';

let root: string;
let store: FsJobStore;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-selections-'));
  store = new FsJobStore(root);
  const backend = new StubBackend();
  let clock = Date.parse('2026-10-09T00:00:00Z');
  const now = () => new Date((clock += 1000));
  app = createApi({
    backend,
    store,
    manualRunner: new ManualGenerationRunner({ backend, store, now }),
    autoQueue: {
      kick: () => undefined,
      stop: async () => undefined,
      addInstruction: notUsed,
      changeStopConditions: notUsed,
      addReference: notUsed,
    },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    env: {},
    now,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}

const request = generationRequestSchema.parse({
  prompt: 'girl, beach',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
  batchSize: 2,
});

const twoImages: GenerationResult = {
  images: [0, 1].map((i) => ({ png: Uint8Array.of(137, 80, 78, 71, i), seed: i, metadata: {} })),
  metadata: {},
};

/** 回を2つ（2回目と10回目）回し終えた自動ジョブ。10回目だけ見る役の評価がある */
async function jobWithImages(): Promise<string> {
  const spec = await store.createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺の少女',
      stopConditions: { aiJudgement: true },
      batchSize: 2,
    },
    { status: 'queued', carry: { intent: '夕暮れの海辺の少女', completedIterations: 0 } },
    new Date('2026-10-09T00:00:00Z'),
  );
  await store.writeGeneration(spec.jobId, 2, request, twoImages);
  await store.writeGeneration(spec.jobId, 10, request, twoImages);
  await store.writeStage(spec.jobId, 10, 'judge', {
    images: [
      { score: 0.4, issues: ['背景が暗い'] },
      { score: 0.9, issues: ['指が崩れている'] },
    ],
    nextChange: 'もっと逆光にする',
    canStop: false,
  });
  return spec.jobId;
}

const put = (jobId: string, imageKey: string, body: unknown) =>
  app.request(`/jobs/${jobId}/selections/${imageKey}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function selections(jobId: string): Promise<unknown> {
  const res = await app.request(`/jobs/${jobId}/selections`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { selections: unknown }).selections;
}

describe('selections of the images of a job', () => {
  it('marks an image as a favorite and serves it with the judge score and issues', async () => {
    const jobId = await jobWithImages();

    const res = await put(jobId, '10-1', { verdict: 'favorite' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      selection: { imageKey: '10-1', verdict: 'favorite' },
    });
    expect(await selections(jobId)).toEqual([
      { imageKey: '10-1', verdict: 'favorite', score: 0.9, issues: ['指が崩れている'] },
    ]);
  });

  it('keeps what a reselection replaced, down to clearing the choice', async () => {
    const jobId = await jobWithImages();

    await put(jobId, '10-0', { verdict: 'favorite' });
    await put(jobId, '10-0', { verdict: 'rejected' });
    expect(await selections(jobId)).toEqual([
      {
        imageKey: '10-0',
        verdict: 'rejected',
        previous: 'favorite',
        score: 0.4,
        issues: ['背景が暗い'],
      },
    ]);

    await put(jobId, '10-0', { verdict: null });
    expect(await selections(jobId)).toMatchObject([
      { imageKey: '10-0', verdict: null, previous: 'rejected' },
    ]);
  });

  it('lists selections in iteration order, with no score for an image the judge never saw', async () => {
    const jobId = await jobWithImages();

    await put(jobId, '10-0', { verdict: 'rejected' });
    await put(jobId, '2-1', { verdict: 'favorite' });

    expect(await selections(jobId)).toEqual([
      { imageKey: '2-1', verdict: 'favorite', issues: [] },
      { imageKey: '10-0', verdict: 'rejected', score: 0.4, issues: ['背景が暗い'] },
    ]);
  });

  it('refuses an image that was never generated, a malformed key and an unknown verdict', async () => {
    const jobId = await jobWithImages();

    expect((await put(jobId, '10-5', { verdict: 'favorite' })).status).toBe(404);
    expect((await put(jobId, '3-0', { verdict: 'favorite' })).status).toBe(404);
    expect((await put(jobId, '10_1', { verdict: 'favorite' })).status).toBe(400);
    expect((await put(jobId, '10-1', { verdict: 'love' })).status).toBe(400);
    expect((await put(jobId, '10-1', {})).status).toBe(400);
    expect(await selections(jobId)).toEqual([]);
  });

  it('gives the hono client a typed body for a selection', async () => {
    const jobId = await jobWithImages();
    const client = hc<AppType>('http://localhost', { fetch: app.request });
    const select = client.jobs[':jobId'].selections[':imageKey'];

    const res = await select.$put({
      param: { jobId, imageKey: '10-1' },
      json: { verdict: 'favorite' },
    });
    expect(res.status).toBe(200);

    // 選択の形が違えば、送る前に型で弾かれる
    const wrong = () =>
      select.$put({
        param: { jobId, imageKey: '10-1' },
        // @ts-expect-error verdict は favorite・rejected・null のどれか
        json: { verdict: 'love' },
      });
    expect((await wrong()).status).toBe(400);
  });

  it('answers 404 for a job that does not exist', async () => {
    expect((await put('no-such-job', '1-0', { verdict: 'favorite' })).status).toBe(404);
    expect((await app.request('/jobs/no-such-job/selections')).status).toBe(404);
  });
});
