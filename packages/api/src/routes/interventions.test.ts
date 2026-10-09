import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BUDGET,
  generationRequestSchema,
  JobRunner,
  ManualGenerationRunner,
  THINK_PARAM_KEYS,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend } from '@drawroid/core/testing';
import { createFsMemoryStore, dataPaths, FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hc } from 'hono/client';

import { createApi, type AppType } from '../index.js';

let root: string;
let store: FsJobStore;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-interventions-'));
  store = new FsJobStore(root);
  const backend = new StubBackend();
  let clock = Date.parse('2026-10-09T00:00:00Z');
  const now = () => new Date((clock += 1000));
  // 回さない: 口出しの受け付けだけを見る。回したときの効き目は storage-fs の runner.test.ts が見る
  const runner = new JobRunner({
    store,
    llm: new ScriptedLlm({}),
    backend,
    budget: DEFAULT_BUDGET,
    allowed: THINK_PARAM_KEYS,
    defaults: { width: 64, height: 64, steps: 4, cfgScale: 7, negativePrompt: '' },
    now,
  });
  app = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore(dataPaths(root).memory),
    manualRunner: new ManualGenerationRunner({ backend, store, now }),
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
    autoQueue: {
      kick: () => undefined,
      stop: (jobId) => runner.stop(jobId),
      addInstruction: (jobId, text) => runner.addInstruction(jobId, text),
      changeStopConditions: (jobId, change) => runner.changeStopConditions(jobId, change),
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

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function createAuto(stopConditions: unknown = { aiJudgement: false, maxIterations: 5 }) {
  const res = await post('/jobs/auto', { request: '夕暮れの海辺の少女', stopConditions });
  expect(res.status).toBe(202);
  return ((await res.json()) as { jobId: string }).jobId;
}

const intervene = (jobId: string, body: unknown) => post(`/jobs/auto/${jobId}/interventions`, body);

describe('POST /jobs/auto/:jobId/interventions', () => {
  it('keeps a human instruction as it was said, not yet taken into a think', async () => {
    const jobId = await createAuto();

    const res = await intervene(jobId, { kind: 'instruction', text: '逆光にして' });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      intervention: { kind: 'instruction', text: '逆光にして' },
    });
    const [stored] = await store.listInterventions(jobId);
    expect(stored).toMatchObject({ kind: 'instruction', text: '逆光にして' });
    expect(stored).not.toHaveProperty('appliedInIteration');
  });

  it('changes the stop conditions and answers with the ones now in effect', async () => {
    const jobId = await createAuto();

    const res = await intervene(jobId, {
      kind: 'stopConditions',
      stopConditions: { maxIterations: 2, maxImages: 6 },
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      stopConditions: { aiJudgement: false, maxIterations: 2, maxImages: 6 },
    });
    expect(await store.readJob(jobId)).toMatchObject({
      stopConditions: { aiJudgement: false, maxIterations: 5 },
    });
  });

  it('refuses a change that would leave the job with no way to stop, with the reason', async () => {
    const jobId = await createAuto();

    const res = await intervene(jobId, {
      kind: 'stopConditions',
      stopConditions: { maxIterations: null },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe('invalid_request');
    expect(body.error.message).toContain('止まらなくなる');
    expect(await store.listInterventions(jobId)).toEqual([]);
  });

  it('refuses an intervention to a job that has already stopped', async () => {
    const jobId = await createAuto();
    expect((await post(`/jobs/auto/${jobId}/stop`, {})).status).toBe(202);

    const res = await intervene(jobId, { kind: 'instruction', text: '逆光にして' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe('conflict');
    expect(await store.listInterventions(jobId)).toEqual([]);
  });

  it('refuses a body it cannot read, writing nothing', async () => {
    const jobId = await createAuto();

    for (const body of [
      { kind: 'instruction', text: '   ' },
      { kind: 'stopConditions', stopConditions: {} },
      { kind: 'stopConditions', stopConditions: { maxIterations: 0 } },
      { kind: 'mask' },
      undefined,
    ]) {
      expect((await intervene(jobId, body)).status).toBe(400);
    }
    expect(await store.listInterventions(jobId)).toEqual([]);
  });

  it('gives the hono client a typed body for an intervention', async () => {
    const jobId = await createAuto();
    const client = hc<AppType>('http://localhost', { fetch: app.request });
    const interventions = client.jobs.auto[':jobId'].interventions;

    const res = await interventions.$post({
      param: { jobId },
      json: { kind: 'instruction', text: '逆光にして' },
    });
    expect(res.status).toBe(202);

    // 本文の形が違えば、送る前に型で弾かれる
    const wrong = () =>
      interventions.$post({
        param: { jobId },
        // @ts-expect-error instruction には text が要る
        json: { kind: 'instruction' },
      });
    expect((await wrong()).status).toBe(400);
  });

  it('answers 404 for a job that is not an automatic job', async () => {
    const manual = await store.createJob(
      {
        kind: 'manual',
        request: generationRequestSchema.parse({
          prompt: 'a cat',
          steps: 4,
          cfgScale: 7,
          width: 64,
          height: 64,
        }),
      },
      { status: 'queued' },
      new Date(),
    );

    expect((await intervene(manual.jobId, { kind: 'instruction', text: 'x' })).status).toBe(404);
    expect((await intervene('no-such-job', { kind: 'instruction', text: 'x' })).status).toBe(404);
  });
});

describe('GET /jobs/auto/:jobId/stop-conditions', () => {
  it('reads the stop conditions in effect, after changes, next to the submitted ones', async () => {
    const jobId = await createAuto({ aiJudgement: false, maxIterations: 5 });
    await intervene(jobId, { kind: 'stopConditions', stopConditions: { maxIterations: 8 } });
    await intervene(jobId, { kind: 'stopConditions', stopConditions: { maxImages: 20 } });

    const res = await app.request(`/jobs/auto/${jobId}/stop-conditions`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      submitted: { aiJudgement: false, maxIterations: 5 },
      current: { aiJudgement: false, maxIterations: 8, maxImages: 20 },
    });
  });

  it('answers 404 for a job that is not an automatic job', async () => {
    expect((await app.request('/jobs/auto/no-such-job/stop-conditions')).status).toBe(404);
  });
});
