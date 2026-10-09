import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackendError, DEFAULT_BUDGET, ManualGenerationRunner } from '@drawroid/core';
import { STUB_PNG, StubBackend } from '@drawroid/core/testing';
import { dataPaths, FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApi } from './index.js';

let root: string;
let backend: StubBackend;
let api: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-'));
  backend = new StubBackend();
  const store = new FsJobStore(root);
  // 呼ぶたびに1秒進める: jobId は秒までしか持たず、同じ秒に作ったジョブの順は決まらないため
  let clock = Date.parse('2026-10-09T06:30:00Z');
  const now = () => new Date((clock += 1000));
  api = createApi({
    backend,
    store,
    manualRunner: new ManualGenerationRunner({ backend, store, now }),
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
    autoQueue: { kick: () => undefined, stop: async () => undefined },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    env: {},
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const params = { prompt: 'a cat', steps: 4, cfgScale: 7, width: 64, height: 64, batchSize: 2 };

function post(path: string, body: unknown) {
  return api.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function generate(body: unknown = params): Promise<string> {
  const res = await post('/jobs/manual', body);
  expect(res.status).toBe(202);
  const { jobId } = (await res.json()) as { jobId: string };
  await vi.waitFor(async () => {
    const detail = (await (await api.request(`/jobs/${jobId}`)).json()) as {
      state: { status: string };
    };
    expect(detail.state.status).toBe('stopped');
  });
  return jobId;
}

describe('health', () => {
  it('answers the health check', async () => {
    const res = await api.request('/health');
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('backend', () => {
  it('reports the capabilities of the backend', async () => {
    const res = await api.request('/backend');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ capabilities: { unavailable: [] } });
  });

  it('tells the screen why the backend cannot be reached', async () => {
    backend.setUnreachable(true);
    const res = await api.request('/backend');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { kind: 'unreachable' } });
  });

  it('lists candidates of a kind, and refuses an unknown kind', async () => {
    const res = await api.request('/backend/candidates/lora');
    expect(await res.json()).toEqual({
      candidates: [{ name: 'stub-lora-a' }, { name: 'stub-lora-b' }],
    });
    expect((await api.request('/backend/candidates/nope')).status).toBe(400);
  });
});

// M1 の受け入れ基準「スタブのバックエンドに対して、生成・保存・取得がテストで通る」を、HTTP API を通して確かめる
describe('manual jobs', () => {
  it('generates with explicit parameters, then serves the job and its images', async () => {
    const jobId = await generate({ ...params, seed: 5 });
    const detail = (await (await api.request(`/jobs/${jobId}`)).json()) as {
      spec: unknown;
      state: unknown;
      iterations: { request: unknown; images: { index: number; seed: number; url: string }[] }[];
    };
    expect(detail.spec).toMatchObject({ kind: 'manual', jobId, request: { prompt: 'a cat' } });
    expect(detail.state).toMatchObject({ status: 'stopped', reason: { kind: 'limit:iterations' } });
    expect(detail.iterations).toHaveLength(1);
    expect(detail.iterations[0]?.request).toMatchObject({ prompt: 'a cat', seed: 5 });
    const images = detail.iterations[0]?.images ?? [];
    expect(images.map((i) => i.seed)).toEqual([5, 6]);

    const image = await api.request((images[1]?.url ?? '').replace(/^\/api/, ''));
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(STUB_PNG);
  });

  it('lists jobs newest first', async () => {
    const first = await generate();
    const second = await generate();
    const { jobs } = (await (await api.request('/jobs')).json()) as { jobs: { jobId: string }[] };
    expect(jobs.map((j) => j.jobId)).toEqual([second, first]);
  });

  it('keeps listing the other jobs when one job file is broken, naming the broken one', async () => {
    const broken = await generate();
    const intact = await generate();
    await writeFile(dataPaths(root).jobFiles(broken).state, '{ "status": ');
    const res = await api.request('/jobs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: { jobId: string }[];
      invalid: { jobId: string; reason: string }[];
    };
    expect(body.jobs.map((j) => j.jobId)).toEqual([intact]);
    expect(body.invalid).toEqual([
      { jobId: broken, reason: expect.stringContaining('state.json') as unknown },
    ]);
  });

  it('records the cause when the backend fails, so the screen can show it', async () => {
    backend.failNextGenerate(
      new BackendError('unreachable', 'http://127.0.0.1:7860/ に繋がらない'),
    );
    const jobId = await generate();
    const detail = (await (await api.request(`/jobs/${jobId}`)).json()) as { state: unknown };
    expect(detail.state).toMatchObject({
      status: 'stopped',
      reason: { kind: 'error', detail: expect.stringContaining('7860') as unknown },
    });
  });

  it('refuses parameters that do not fit the request schema', async () => {
    const res = await post('/jobs/manual', { prompt: 'a cat' });
    expect(res.status).toBe(400);
    expect(backend.requests).toEqual([]);
  });
});

describe('not found', () => {
  it('answers 404 for a job that does not exist or an id that is not a job id', async () => {
    expect((await api.request('/jobs/20261009-063012-aaaaaa')).status).toBe(404);
    expect((await api.request('/jobs/..%2F..')).status).toBe(404);
  });

  it('serves only images under jobs/, by number', async () => {
    const jobId = await generate();
    for (const path of [
      `/files/jobs/${jobId}/iterations/1/images/9.png`,
      `/files/jobs/${jobId}/iterations/0/images/0.png`,
      `/files/jobs/${jobId}/iterations/1/images/0.json`,
      `/files/jobs/..%2F..%2Fconfig.json/iterations/1/images/0.png`,
    ]) {
      expect((await api.request(path)).status, path).toBe(404);
    }
  });
});
