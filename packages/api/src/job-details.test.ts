import { rm, writeFile } from 'node:fs/promises';

import { DEFAULT_BUDGET } from '@drawroid/core';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutoJob, png, request, setup } from './test-support.js';

let env: Awaited<ReturnType<typeof setup>>;
let jobId: string;

beforeEach(async () => {
  env = await setup();
  jobId = (
    await createAutoJob(env.store, {
      status: 'stopped',
      stoppedAt: '2026-10-09T01:00:00.000Z',
      imagesGenerated: 2,
      reason: { kind: 'limit:iterations', detail: '5 回に達した' },
    })
  ).jobId;
  await env.store.writeStage(jobId, 1, 'think', { params: {}, rationale: 'r' });
  await env.store.writeGeneration(jobId, 1, request, {
    images: [{ png: await png(1024, 768), seed: 7, metadata: {} }],
    metadata: {},
  });
  await env.store.writeStage(jobId, 1, 'judge', {
    images: [{ score: 0.8, issues: [] }],
    nextChange: 'x',
    canStop: true,
  });
  await env.store.writeStage(jobId, 2, 'think', { params: {}, rationale: 'r2' });
});
afterEach(async () => {
  await rm(env.root, { recursive: true, force: true });
});

describe('GET /jobs/:jobId/iterations/:iteration and the human choice', () => {
  it('returns the adopted record of an iteration the human picked an image in', async () => {
    const adopted = {
      by: 'human',
      image: { iteration: 2, index: 0 },
      score: 1,
      interventionId: 'iv-1',
      adoptedAt: '2026-10-09T00:30:00.000Z',
    } as const;
    await env.store.writeAdopted(jobId, 2, adopted);

    const res = await env.api.request(`/jobs/${jobId}/iterations/2`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ iteration: 2, judge: null, adopted });
  });

  it('returns adopted as null for an iteration the judge evaluated', async () => {
    const res = await env.api.request(`/jobs/${jobId}/iterations/1`);

    expect(await res.json()).toMatchObject({ judge: { canStop: true }, adopted: null });
  });
});

describe('GET /jobs/:jobId', () => {
  it('returns the stop reason, the stop conditions and a per-iteration summary', async () => {
    const res = await env.api.request(`/jobs/${jobId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      spec: { stopConditions: { aiJudgement: true, maxIterations: 5 } },
      state: { status: 'stopped', reason: { kind: 'limit:iterations' } },
      iterations: [
        {
          iteration: 1,
          request: { prompt: 'a cat' },
          images: [
            {
              index: 0,
              seed: 7,
              url: `/api/files/jobs/${jobId}/iterations/1/images/0.png`,
              previewUrl: `/api/files/jobs/${jobId}/iterations/1/images/0.preview.webp`,
            },
          ],
          judge: { canStop: true, scores: [0.8] },
        },
        { iteration: 2, request: null, images: [], judge: null },
      ],
      invalid: [],
    });
  });

  it('summarizes an iteration the human picked an image in, instead of leaving its scores empty', async () => {
    await env.store.writeGeneration(jobId, 2, request, {
      images: [
        { png: await png(64, 64), seed: 1, metadata: {} },
        { png: await png(64, 64), seed: 2, metadata: {} },
      ],
      metadata: {},
    });
    await env.store.writeAdopted(jobId, 2, {
      by: 'human',
      image: { iteration: 2, index: 1 },
      score: 1,
      interventionId: 'iv-1',
      adoptedAt: '2026-10-09T00:30:00.000Z',
    });

    const res = await env.api.request(`/jobs/${jobId}`);

    const body = (await res.json()) as { iterations: { iteration: number; judge: unknown }[] };
    expect(body.iterations.find((i) => i.iteration === 2)?.judge).toEqual({
      canStop: false,
      scores: [0, 1],
      adopted: true,
    });
  });

  it('lists a broken iteration as invalid and still returns the rest of the detail', async () => {
    await writeFile(env.paths.jobFiles(jobId).iteration(1).think, '{ broken');

    const res = await env.api.request(`/jobs/${jobId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      iterations: { iteration: number }[];
      invalid: { iteration: number; reason: string }[];
    };
    expect(body.iterations.map((i) => i.iteration)).toEqual([2]);
    expect(body.invalid).toHaveLength(1);
    expect(body.invalid[0]).toMatchObject({ iteration: 1 });
  });
});

// 画面は走っている間これを毎秒読む: 回の一覧は /iterations から取るので、ここには回を載せない
describe('GET /jobs/:jobId/overview', () => {
  it('returns the spec and the state, without the iterations', async () => {
    const res = await env.api.request(`/jobs/${jobId}/overview`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      spec: await env.store.readJob(jobId),
      state: await env.store.readState(jobId),
    });
  });

  it('answers even when an iteration cannot be read', async () => {
    await writeFile(env.paths.jobFiles(jobId).iteration(1).think, '{ broken');

    const res = await env.api.request(`/jobs/${jobId}/overview`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: { status: 'stopped' } });
  });

  it('answers 404 for a job that does not exist or an id that is not a job id', async () => {
    expect((await env.api.request('/jobs/20261009-063012-zzzzzz/overview')).status).toBe(404);
    expect((await env.api.request('/jobs/..%2F..%2Fx/overview')).status).toBe(404);
  });
});

describe('GET /files/.../images/:n.preview.webp', () => {
  const path = (id: string, file: string) => `/files/jobs/${id}/iterations/1/images/${file}`;

  it('serves a webp no longer than the budget on its long edge', async () => {
    const res = await env.api.request(path(jobId, '0.preview.webp'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      DEFAULT_BUDGET.imageLongEdge,
    );
  });

  it('still serves the original png', async () => {
    const res = await env.api.request(path(jobId, '0.png'));
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('returns 404 when the original image does not exist', async () => {
    const res = await env.api.request(path(jobId, '5.preview.webp'));
    expect(res.status).toBe(404);
  });

  it.each(['..%2F0.preview.webp', 'a.preview.webp', '0.preview.png', '0.preview.webp.json'])(
    'returns 404 for the file name %s',
    async (file) => {
      expect((await env.api.request(path(jobId, file))).status).toBe(404);
    },
  );

  it('returns 404 for a job id that is not listed', async () => {
    const res = await env.api.request(path('..', '0.preview.webp'));
    expect(res.status).toBe(404);
  });
});
