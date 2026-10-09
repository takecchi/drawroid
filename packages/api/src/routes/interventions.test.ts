import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  generationRequestSchema,
  JobRunner,
  ManualGenerationRunner,
} from '@drawroid/core';
import { ScriptedLlm, STUB_PNG, StubBackend } from '@drawroid/core/testing';
import { createFsMemoryStore, dataPaths, FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hc } from 'hono/client';

import { createApi, type AppType } from '../index.js';
import { MAX_MASK_BYTES } from '../masks.js';
import { MAX_REFERENCE_BYTES } from '../references.js';
import { noCandidateNotes, noPermissionSettings } from '../test-support.js';

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
    permissions: basicPermissions({ width: 64, height: 64 }),
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
      addReference: (jobId, reference) => runner.addReference(jobId, reference),
      addMask: (jobId, mask) => runner.addMask(jobId, mask),
    },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
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

  it('accepts an instruction up to 2000 characters and refuses a longer one, writing nothing', async () => {
    const jobId = await createAuto();

    for (const length of [21, 2000]) {
      const text = '光'.repeat(length);
      expect((await intervene(jobId, { kind: 'instruction', text })).status).toBe(202);
    }
    expect(await store.listInterventions(jobId)).toHaveLength(2);

    const res = await intervene(jobId, { kind: 'instruction', text: '光'.repeat(2001) });

    expect(res.status).toBe(400);
    expect(await store.listInterventions(jobId)).toHaveLength(2);
  });

  it('reads back what humans said to a job, as they said it', async () => {
    const jobId = await createAuto();
    await intervene(jobId, { kind: 'instruction', text: '逆光にして' });

    const res = await app.request(`/jobs/auto/${jobId}/interventions`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      interventions: [expect.objectContaining({ kind: 'instruction', text: '逆光にして' })],
    });
    expect((await app.request('/jobs/auto/no-such-job/interventions')).status).toBe(404);
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

describe('reference images, at submission and as an intervention', () => {
  const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
  const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16);
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  it('keeps the images attached to a submitted job, in the order given', async () => {
    const res = await post('/jobs/auto', {
      request: '夕暮れの海辺の少女',
      references: [
        { mediaType: 'image/png', data: b64(PNG), note: 'この構図で' },
        { mediaType: 'image/jpeg', data: b64(JPEG) },
      ],
    });

    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    const references = await store.listReferences(jobId);
    expect(references.map((r) => [r.mediaType, r.note])).toEqual([
      ['image/png', 'この構図で'],
      ['image/jpeg', undefined],
    ]);
  });

  it('takes an image as an intervention to a running or queued job', async () => {
    const jobId = await createAuto();

    const res = await intervene(jobId, {
      kind: 'reference',
      image: { mediaType: 'image/png', data: b64(PNG), note: '服はこれ' },
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      reference: { mediaType: 'image/png', note: '服はこれ' },
    });
    expect(await store.listReferences(jobId)).toHaveLength(1);
  });

  it('refuses an image for a job that has already stopped', async () => {
    const jobId = await createAuto();
    await post(`/jobs/auto/${jobId}/stop`, {});

    const res = await intervene(jobId, {
      kind: 'reference',
      image: { mediaType: 'image/png', data: b64(PNG) },
    });

    expect(res.status).toBe(409);
    expect(await store.listReferences(jobId)).toEqual([]);
  });

  it('refuses images it does not take, creating no job and writing nothing', async () => {
    const jobId = await createAuto();
    const before = await store.listJobIds();
    const tooLarge = new Uint8Array(MAX_REFERENCE_BYTES + 1);
    tooLarge.set(PNG);

    for (const image of [
      { mediaType: 'image/png', data: b64(JPEG) },
      { mediaType: 'image/gif', data: b64(PNG) },
      { mediaType: 'image/png', data: '*** not base64 ***' },
      { mediaType: 'image/png', data: b64(tooLarge) },
    ]) {
      expect((await intervene(jobId, { kind: 'reference', image })).status).toBe(400);
      expect((await post('/jobs/auto', { request: '海辺', references: [image] })).status).toBe(400);
    }
    const five = Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: b64(PNG) }));
    expect((await post('/jobs/auto', { request: '海辺', references: five })).status).toBe(400);

    expect(await store.listReferences(jobId)).toEqual([]);
    expect(await store.listJobIds()).toEqual(before);
  });
});

describe('inpaint masks, as an intervention', () => {
  const png = Buffer.from(STUB_PNG).toString('base64');

  async function withFirstImage(jobId: string) {
    await store.writeGeneration(
      jobId,
      1,
      generationRequestSchema.parse({ prompt: 'a', steps: 4, cfgScale: 7, width: 64, height: 64 }),
      { images: [{ png: STUB_PNG, seed: 1, metadata: {} }], metadata: {} },
    );
  }

  it('keeps a mask painted on an image of the job, tied to that image', async () => {
    const jobId = await createAuto();
    await withFirstImage(jobId);

    const res = await intervene(jobId, {
      kind: 'mask',
      image: { iteration: 1, index: 0 },
      mask: { data: png },
    });

    expect(res.status).toBe(202);
    const [stored] = await store.listInterventions(jobId);
    expect(stored).toMatchObject({ kind: 'mask', image: { iteration: 1, index: 0 } });
    expect(stored).not.toHaveProperty('usedInIteration');
    const mask = await store.readMask(jobId, stored!.interventionId);
    expect(Array.from(mask ?? [])).toEqual(Array.from(STUB_PNG));
  });

  it('refuses a mask painted on an image the job does not have, writing nothing', async () => {
    const jobId = await createAuto();

    const res = await intervene(jobId, {
      kind: 'mask',
      image: { iteration: 1, index: 0 },
      mask: { data: png },
    });

    expect(res.status).toBe(404);
    expect(await store.listInterventions(jobId)).toEqual([]);
  });

  // PNG の署名で始まる、指定した大きさのバイト列
  const pngOfSize = (bytes: number) => {
    const data = new Uint8Array(bytes);
    data.set(STUB_PNG.subarray(0, 8));
    return Buffer.from(data).toString('base64');
  };

  it('accepts a mask of exactly the size limit', async () => {
    const jobId = await createAuto();
    await withFirstImage(jobId);

    const res = await intervene(jobId, {
      kind: 'mask',
      image: { iteration: 1, index: 0 },
      mask: { data: pngOfSize(MAX_MASK_BYTES) },
    });

    expect(res.status).toBe(202);
    expect(await store.listInterventions(jobId)).toHaveLength(1);
  });

  it('refuses a mask over the size limit, writing nothing', async () => {
    const jobId = await createAuto();
    await withFirstImage(jobId);

    const res = await intervene(jobId, {
      kind: 'mask',
      image: { iteration: 1, index: 0 },
      mask: { data: pngOfSize(MAX_MASK_BYTES + 1) },
    });

    expect(res.status).toBe(400);
    expect(await store.listInterventions(jobId)).toEqual([]);
  });

  it('refuses a mask that is not a PNG', async () => {
    const jobId = await createAuto();
    await withFirstImage(jobId);

    const res = await intervene(jobId, {
      kind: 'mask',
      image: { iteration: 1, index: 0 },
      mask: { data: Buffer.from('not a png').toString('base64') },
    });

    expect(res.status).toBe(400);
    expect(await store.listInterventions(jobId)).toEqual([]);
  });
});

describe('the reference images attached to a job, read back (Issue #46)', () => {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  it('lists the images in the order received, with the words a human added', async () => {
    const res = await post('/jobs/auto', {
      request: '夕暮れの海辺の少女',
      references: [{ mediaType: 'image/png', data: b64(STUB_PNG), note: 'この構図で' }],
    });
    const { jobId } = (await res.json()) as { jobId: string };
    await intervene(jobId, {
      kind: 'reference',
      image: { mediaType: 'image/png', data: b64(STUB_PNG), note: '服はこれ' },
    });

    const listed = await app.request(`/jobs/auto/${jobId}/references`);

    expect(listed.status).toBe(200);
    const { references } = (await listed.json()) as {
      references: { refId: string; note?: string; gist?: string; previewUrl: string }[];
    };
    expect(references.map((r) => r.note)).toEqual(['この構図で', '服はこれ']);
    expect(references.every((r) => r.gist === undefined)).toBe(true);
  });

  it('shows the gist and the call that made it, once the judge has looked at the image', async () => {
    const jobId = await createAuto();
    await intervene(jobId, {
      kind: 'reference',
      image: { mediaType: 'image/png', data: b64(STUB_PNG) },
    });
    const [stored] = await store.listReferences(jobId);
    await store.writeReferenceGist(jobId, stored!.refId, '白いワンピースの立ち姿');
    await store.markSent({ jobId, refId: stored!.refId }, 'call-0001', new Date());

    const { references } = (await (await app.request(`/jobs/auto/${jobId}/references`)).json()) as {
      references: { gist?: string; sentInCall?: string }[];
    };

    expect(references[0]).toMatchObject({
      gist: '白いワンピースの立ち姿',
      sentInCall: 'call-0001',
    });
  });

  it('serves a reduced copy of each listed image', async () => {
    const jobId = await createAuto();
    await intervene(jobId, {
      kind: 'reference',
      image: { mediaType: 'image/png', data: b64(STUB_PNG) },
    });
    const { references } = (await (await app.request(`/jobs/auto/${jobId}/references`)).json()) as {
      references: { previewUrl: string }[];
    };

    const image = await app.request(references[0]!.previewUrl.replace(/^\/api/, ''));

    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/webp');
  });

  it('answers 404 for a job that is not an automatic job, and for an image the job does not have', async () => {
    const jobId = await createAuto();

    expect((await app.request('/jobs/auto/no-such-job/references')).status).toBe(404);
    expect((await app.request(`/files/jobs/${jobId}/refs/000009.preview.webp`)).status).toBe(404);
  });
});
