import { rm, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutoJob, png, request, setup } from '../test-support.js';

let env: Awaited<ReturnType<typeof setup>>;
let jobId: string;

beforeEach(async () => {
  env = await setup();
  jobId = (await createAutoJob(env.store)).jobId;
  const judge = { images: [{ score: 0.4, issues: [] }], nextChange: 'x', canStop: false };
  await env.store.writeStage(jobId, 1, 'think', { params: { prompt: 'girl' }, rationale: 'r1' });
  await env.store.writeGeneration(jobId, 1, request, {
    images: [{ png: await png(64, 64), seed: 7, metadata: {} }],
    metadata: {},
  });
  await env.store.writeStage(jobId, 1, 'judge', judge);
  // 2回目は think だけ: 生成の前に落ちた回
  await env.store.writeStage(jobId, 2, 'think', { params: {}, rationale: 'r2' });
});
afterEach(async () => {
  await rm(env.root, { recursive: true, force: true });
});

describe('GET /jobs/:jobId/iterations', () => {
  it('returns think, request, judge and image urls of each iteration', async () => {
    const res = await env.api.request(`/jobs/${jobId}/iterations`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { iterations: unknown[]; invalid: unknown[] };
    expect(body.invalid).toEqual([]);
    expect(body.iterations).toMatchObject([
      {
        iteration: 1,
        think: { rationale: 'r1' },
        request: { prompt: 'a cat' },
        judge: { canStop: false },
        images: [
          {
            index: 0,
            seed: 7,
            url: `/api/files/jobs/${jobId}/iterations/1/images/0.png`,
            previewUrl: `/api/files/jobs/${jobId}/iterations/1/images/0.preview.webp`,
          },
        ],
      },
      { iteration: 2, think: { rationale: 'r2' }, request: null, judge: null, images: [] },
    ]);
  });

  it('returns what was excluded from the AI choices, or null for an iteration without plan.json', async () => {
    const excluded = [
      { param: 'loras', wanted: 'auto', reason: { kind: 'no-candidates-shown' } },
      { param: 'controlnet', wanted: 'fixed', reason: { kind: 'backend', detail: 'no extension' } },
    ];
    await env.store.writeStage(jobId, 1, 'plan', { excluded });

    const res = await env.api.request(`/jobs/${jobId}/iterations`);

    const body = (await res.json()) as { iterations: { excluded: unknown }[] };
    expect(body.iterations.map((i) => i.excluded)).toEqual([excluded, null]);
  });

  it('reports the iteration as invalid when plan.json does not match its shape', async () => {
    await env.store.writeStage(jobId, 1, 'plan', { excluded: [{ param: 'nope' }] });

    const res = await env.api.request(`/jobs/${jobId}/iterations`);

    const body = (await res.json()) as {
      iterations: { iteration: number }[];
      invalid: { iteration: number }[];
    };
    expect(body.iterations.map((i) => i.iteration)).toEqual([2]);
    expect(body.invalid.map((i) => i.iteration)).toEqual([1]);
  });

  it('reports only the iteration with a broken file as invalid and still returns the others', async () => {
    await writeFile(env.paths.jobFiles(jobId).iteration(1).think, '{ broken');

    const res = await env.api.request(`/jobs/${jobId}/iterations`);

    const body = (await res.json()) as {
      iterations: { iteration: number }[];
      invalid: { iteration: number; reason: string }[];
    };
    expect(res.status).toBe(200);
    expect(body.iterations.map((i) => i.iteration)).toEqual([2]);
    expect(body.invalid).toHaveLength(1);
    expect(body.invalid[0]).toMatchObject({ iteration: 1 });
    expect(body.invalid[0]?.reason).not.toBe('');
  });

  it('returns 404 for an unknown job', async () => {
    const res = await env.api.request('/jobs/20260101-000000-zzzzzz/iterations');
    expect(res.status).toBe(404);
  });
});

describe('GET /jobs/:jobId/iterations/:iteration', () => {
  it('returns one iteration', async () => {
    const res = await env.api.request(`/jobs/${jobId}/iterations/2`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ iteration: 2, request: null });
  });

  it('answers 422 invalid_file instead of 500 when a file of the iteration is broken', async () => {
    await writeFile(env.paths.jobFiles(jobId).iteration(1).judge, 'nope');

    const res = await env.api.request(`/jobs/${jobId}/iterations/1`);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_file' } });
  });

  it.each(['3', '0', '01', 'abc', '..'])('returns 404 for iteration %s', async (iteration) => {
    const res = await env.api.request(`/jobs/${jobId}/iterations/${iteration}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown job', async () => {
    const res = await env.api.request('/jobs/20260101-000000-zzzzzz/iterations/1');
    expect(res.status).toBe(404);
  });
});
