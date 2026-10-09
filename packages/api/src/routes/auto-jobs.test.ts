import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_BUDGET } from '@drawroid/core';
import { FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../index.js';

let root: string;
let store: FsJobStore;
let kicks: number;
let clock: number;
let stops: string[];
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-'));
  store = new FsJobStore(root);
  kicks = 0;
  clock = 0;
  stops = [];
  app = createApi({
    store,
    queue: {
      kick: () => void kicks++,
      stop: async (jobId) => void stops.push(jobId),
    },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    env: {},
    // jobId は秒単位の時刻で並ぶので、作成順を試験で確かめられるよう1回ごとに1秒進める
    now: () => new Date(Date.parse('2026-10-09T00:00:00Z') + 1000 * clock++),
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

describe('POST /jobs/auto', () => {
  it('queues a job with the defaults, lists it, and kicks the queue', async () => {
    const jobId = await create();

    expect(kicks).toBe(1);
    const res = await app.request(`/jobs/auto/${jobId}`);
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
    });
  });

  it('keeps the stop conditions and batch size the caller gave', async () => {
    const jobId = await create({
      request: 'x',
      stopConditions: { aiJudgement: false, maxImages: 6 },
      batchSize: 3,
    });
    const body = (await (await app.request(`/jobs/auto/${jobId}`)).json()) as {
      spec: { stopConditions: unknown; batchSize: number };
    };
    expect(body.spec.stopConditions).toEqual({ aiJudgement: false, maxImages: 6 });
    expect(body.spec.batchSize).toBe(3);
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

  it('rejects a body that is not JSON with 400', async () => {
    const res = await app.request('/jobs/auto', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });
});

describe('GET /jobs/auto', () => {
  it('lists auto jobs in creation order and leaves out manual jobs', async () => {
    const first = await create({ request: 'one' });
    await store.createJob(
      { kind: 'manual' },
      { status: 'queued', carry: { intent: '', completedIterations: 0 } },
      new Date('2026-10-09T00:00:00Z'),
    );
    const second = await create({ request: 'two' });

    const res = await app.request('/jobs/auto');
    const { jobs } = (await res.json()) as { jobs: { spec: { jobId: string } }[] };
    expect(jobs.map((j) => j.spec.jobId)).toEqual([first, second]);
  });
});

describe('GET /jobs/auto/:jobId', () => {
  it('answers 404 for an unknown job', async () => {
    const res = await app.request('/jobs/auto/20260101-000000-zzzz');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { kind: 'not_found' } });
  });

  it('answers 404 for a path-like id', async () => {
    const res = await app.request('/jobs/auto/..%2F..');
    expect(res.status).toBe(404);
  });

  it('answers 404 for a manual job', async () => {
    const spec = await store.createJob(
      { kind: 'manual' },
      { status: 'queued', carry: { intent: '', completedIterations: 0 } },
      new Date(),
    );
    expect((await app.request(`/jobs/auto/${spec.jobId}`)).status).toBe(404);
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

  it('answers 404 without touching the queue for an unknown job', async () => {
    const res = await app.request('/jobs/auto/nope/stop', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(stops).toEqual([]);
  });
});
