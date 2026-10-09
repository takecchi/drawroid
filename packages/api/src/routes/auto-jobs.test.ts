import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_BUDGET, generationRequestSchema, ManualGenerationRunner } from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { createFsMemoryStore, FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../index.js';

let root: string;
let store: FsJobStore;
let kicks: number;
let stops: string[];
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-'));
  store = new FsJobStore(root);
  kicks = 0;
  stops = [];
  const backend = new StubBackend();
  // 呼ぶたびに1秒進める: jobId は秒までしか持たず、同じ秒に作ったジョブの順は決まらないため
  let clock = Date.parse('2026-10-09T00:00:00Z');
  const now = () => new Date((clock += 1000));
  app = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore(join(root, 'memory')),
    manualRunner: new ManualGenerationRunner({ backend, store, now }),
    autoQueue: {
      kick: () => void kicks++,
      stop: async (jobId) => void stops.push(jobId),
      addInstruction: notUsed,
      changeStopConditions: notUsed,
      addReference: notUsed,
    },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    env: {},
    now,
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function create(body: unknown = { request: '夕暮れの海辺の少女' }): Promise<string> {
  const res = await post('/jobs/auto', body);
  expect(res.status).toBe(202);
  return ((await res.json()) as { jobId: string }).jobId;
}

async function createManual(): Promise<string> {
  const request = generationRequestSchema.parse({
    prompt: 'a cat',
    steps: 4,
    cfgScale: 7,
    width: 64,
    height: 64,
  });
  const spec = await store.createJob({ kind: 'manual', request }, { status: 'queued' }, new Date());
  return spec.jobId;
}

describe('POST /jobs/auto', () => {
  it('queues a job with the defaults, serves it under /jobs, and kicks the queue', async () => {
    const jobId = await create();

    expect(kicks).toBe(1);
    const res = await app.request(`/jobs/${jobId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      spec: {
        kind: 'auto',
        jobId,
        request: '夕暮れの海辺の少女',
        stopConditions: { aiJudgement: true, maxIterations: 10 },
        batchSize: 1,
      },
      state: { status: 'queued', carry: { intent: '夕暮れの海辺の少女', completedIterations: 0 } },
      iterations: [],
    });
  });

  it('keeps the stop conditions and batch size the caller gave', async () => {
    const jobId = await create({
      request: 'x',
      stopConditions: { aiJudgement: false, maxImages: 6 },
      batchSize: 3,
    });
    const body = (await (await app.request(`/jobs/${jobId}`)).json()) as {
      spec: { stopConditions: unknown; batchSize: number };
    };
    expect(body.spec.stopConditions).toEqual({ aiJudgement: false, maxImages: 6 });
    expect(body.spec.batchSize).toBe(3);
  });

  it('lists auto and manual jobs together under /jobs, told apart by kind', async () => {
    const auto = await create();
    const manual = await createManual();
    const { jobs } = (await (await app.request('/jobs')).json()) as {
      jobs: { jobId: string; kind: string }[];
    };
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: auto, kind: 'auto' }),
        expect.objectContaining({ jobId: manual, kind: 'manual' }),
      ]),
    );
  });

  it.each([
    ['an empty request', { request: '' }],
    ['a missing request', {}],
    ['a batch size above 8', { request: 'x', batchSize: 9 }],
    ['a batch size of 0', { request: 'x', batchSize: 0 }],
    ['broken stop conditions', { request: 'x', stopConditions: { maxIterations: -1 } }],
  ])('rejects %s with 400 and creates nothing', async (_name, body) => {
    const res = await post('/jobs/auto', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_request' } });
    expect(await store.listJobIds()).toEqual([]);
    expect(kicks).toBe(0);
  });

  it('rejects stop conditions that would never stop the job, saying why, and creates nothing', async () => {
    const res = await post('/jobs/auto', { request: 'x', stopConditions: { aiJudgement: false } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { kind: 'invalid_request', message: expect.stringContaining('止める条件') },
    });
    expect(await store.listJobIds()).toEqual([]);
    expect(kicks).toBe(0);
  });

  it.each([
    ['the AI judgement alone', { aiJudgement: true }],
    ['an iteration limit alone', { aiJudgement: false, maxIterations: 3 }],
    ['an image limit alone', { aiJudgement: false, maxImages: 6 }],
    ['a time limit alone', { aiJudgement: false, maxDurationMs: 60_000 }],
  ])('accepts %s as a way to stop', async (_name, stopConditions) => {
    await create({ request: 'x', stopConditions });
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await app.request('/jobs/auto', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });
});

describe('POST /jobs/auto/:jobId/stop', () => {
  it('passes the job to the queue and answers 202', async () => {
    const jobId = await create();
    const res = await app.request(`/jobs/auto/${jobId}/stop`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId });
    expect(stops).toEqual([jobId]);
  });

  it.each([
    ['an unknown job', async () => '20260101-000000-zzzz'],
    ['a path-like id', async () => '..%2F..'],
    ['a manual job', createManual],
  ])('answers 404 without touching the queue for %s', async (_name, idOf) => {
    const res = await app.request(`/jobs/auto/${await idOf()}/stop`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { kind: 'not_found' } });
    expect(stops).toEqual([]);
  });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
