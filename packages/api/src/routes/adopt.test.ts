// 画面の「採る」ボタンの口（POST /jobs/:jobId/adopt）を、本物のジョブの実行器と置き場所で見る試験。
// 会話の adopt_image と同じ口（core の adoptImage → JobRunner.adopt）を通り、見る役の前なら見る役を飛ばしてその画像で決まる
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  generationRequestSchema,
  JobRunner,
  ManualGenerationRunner,
  type AutoJobSpec,
  type JobState,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { createFsMemoryStore, dataPaths, FsJobStore } from '@drawroid/storage-fs';
import { blocking } from '@drawroid/storage-fs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AutoJobQueue } from '../deps.js';
import { createApi } from '../index.js';
import {
  memoryBudgetSettings,
  memoryConversations,
  memoryProgressDeps,
  noCandidateNotes,
  noPermissionSettings,
} from '../test-support.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-adopt-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '案',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.4, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}

function setup(options: { withAdopt?: boolean } = {}) {
  const store = new FsJobStore(root);
  const backend = new StubBackend();
  const judging = blocking(judge, (n) => n === 0);
  const llm = new ScriptedLlm({ think, judge: judging.script });
  const runner = new JobRunner({
    store,
    llm,
    backend,
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
  });
  const autoQueue: AutoJobQueue = {
    kick: () => runner.kick(),
    stop: (jobId) => runner.stop(jobId),
    addInstruction: notUsed,
    changeStopConditions: notUsed,
    addReference: notUsed,
    addMask: notUsed,
    ...(options.withAdopt !== false && {
      adopt: (jobId: string, image: { iteration: number; index: number }) =>
        runner.adopt(jobId, image),
    }),
  };
  const app = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore(dataPaths(root).memory),
    manualRunner: new ManualGenerationRunner({ backend, store }),
    backendSettings: { read: notUsed, write: notUsed },
    autoQueue,
    budgetSettings: memoryBudgetSettings(),
    ...memoryProgressDeps(),
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    stopConditionParser: { parse: notUsed },
    conversations: memoryConversations(),
    env: {},
  });
  const submit = async (maxIterations = 3): Promise<AutoJobSpec> => {
    const spec = await store.createJob(
      {
        kind: 'auto',
        request: '海辺',
        stopConditions: { aiJudgement: false, maxIterations },
        batchSize: 1,
      },
      { status: 'queued', carry: { intent: '海辺', completedIterations: 0 } },
      new Date(),
    );
    if (spec.kind !== 'auto') throw new Error('auto のはず');
    return spec;
  };
  const adopt = (jobId: string, body: unknown) =>
    app.request(`/jobs/${jobId}/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { store, backend, llm, runner, judging, submit, adopt };
}

const stopped = async (store: FsJobStore, jobId: string) => {
  const state: JobState = await store.readState(jobId);
  return state.status === 'stopped' ? state.reason.kind : state.status;
};

describe('POST /jobs/:jobId/adopt', () => {
  it('takes the image while the judge looks at it: the judge is cut and not called again, and the job stops on that image', async () => {
    const { store, llm, runner, judging, submit, adopt } = setup();
    const { jobId } = await submit();
    runner.kick();
    await judging.reached(1);

    const res = await adopt(jobId, { iteration: 1, index: 0 });
    await runner.idle();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ adopted: { iteration: 1, index: 0 } });
    expect(judging.signals[0]!.aborted).toBe(true);
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(1);
    expect(await store.readStage(jobId, 1, 'judge')).toBeUndefined();
    expect(await store.readAdopted(jobId, 1)).toMatchObject({
      by: 'human',
      image: { iteration: 1, index: 0 },
    });
    expect(await stopped(store, jobId)).toBe('adopted');
    expect(await store.readSelection(jobId, '1-0')).toMatchObject({ verdict: 'favorite' });
  });

  it('refuses an image that does not exist, writing nothing', async () => {
    const { store, runner, judging, submit, adopt } = setup();
    const { jobId } = await submit();
    runner.kick();
    await judging.reached(1);

    const res = await adopt(jobId, { iteration: 1, index: 3 });

    expect(res.status).toBe(404);
    expect(await store.listInterventions(jobId)).toEqual([]);
    expect(await store.listSelections(jobId)).toEqual([]);
    expect(judging.signals[0]!.aborted).toBe(false);
    await runner.stop(jobId);
    await runner.idle();
  });

  it('refuses a job that has stopped, writing nothing', async () => {
    const { store, runner, judging, submit, adopt } = setup();
    const { jobId } = await submit();
    runner.kick();
    await judging.reached(1);
    await runner.stop(jobId);
    await runner.idle();

    const res = await adopt(jobId, { iteration: 1, index: 0 });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { message: '絵がもう止まっていて、画像 1-0 を採れなかった' },
    });
    expect(await store.listSelections(jobId)).toEqual([]);
    expect(await stopped(store, jobId)).toBe('human');
  });

  // 手動の生成は採る回を持たない。止まっていないのに「止まっていて」と言わない
  it('refuses a manual job that has not stopped, saying it is a manual generation', async () => {
    const { store, backend, adopt } = setup();
    const request = generationRequestSchema.parse({
      prompt: 'a cat',
      steps: 4,
      cfgScale: 7,
      width: 64,
      height: 64,
    });
    const { jobId } = await store.createJob(
      { kind: 'manual', request },
      { status: 'running', startedAt: '2026-10-09T00:00:20Z', imagesGenerated: 0 },
      new Date(),
    );
    await store.writeGeneration(
      jobId,
      1,
      request,
      await backend.generate(request, new AbortController().signal),
    );

    const res = await adopt(jobId, { iteration: 1, index: 0 });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { message: '手動の生成のジョブには、画像 1-0 を採らせられない' },
    });
    expect(await store.listSelections(jobId)).toEqual([]);
  });

  it('refuses when this server cannot take images, and an unknown job', async () => {
    const { store, submit, adopt } = setup({ withAdopt: false });
    const { jobId } = await submit();

    const res = await adopt(jobId, { iteration: 1, index: 0 });

    expect(res.status).toBe(409);
    // 文も縛る: 断る理由ごとに文を分けている口なので、ほかの理由の文と取り違えたら赤にするため
    expect(await res.json()).toMatchObject({
      error: { kind: 'unavailable', message: 'この起動では、画面から画像を採れない' },
    });
    expect(await store.listInterventions(jobId)).toEqual([]);
    expect((await adopt('20261009-000000-zzzz', { iteration: 1, index: 0 })).status).toBe(404);
  });

  it('refuses a body that is not an image', async () => {
    const { submit, adopt } = setup();
    const { jobId } = await submit();

    expect((await adopt(jobId, { iteration: 0, index: 0 })).status).toBe(400);
  });
});
