// M6:156「M1〜M5 のスタブのテストが、A1111 のアダプタでも通る」を、ループを本物のアダプタで回して確かめる試験。
// LLM は台本どおりに返すスタブ、置き場所は本物のファイル（FsJobStore）、バックエンドは偽の A1111 に繋いだ A1111Backend。
// 偽の A1111 の雛形は A1111 v1.10.1（82a973c）のソースから起こしたもので、実機の応答ではない（fixtures/README.md）
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  ManualGenerationRunner,
  type AutoJobSpec,
  type JobState,
  type LlmCall,
} from '@drawroid/core';
import { ScriptedLlm, type Script } from '@drawroid/core/testing';
import { FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { A1111Backend } from './a1111-backend.js';
import { fakeTxt2img, json, startMockA1111, type MockA1111 } from './test-support/mock-a1111.js';

let root: string;
let a1111: MockA1111;
let store: FsJobStore;
let backend: A1111Backend;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-a1111-loop-'));
  a1111 = await startMockA1111();
  store = new FsJobStore(root);
  backend = new A1111Backend({ baseUrl: a1111.url });
});
afterEach(async () => {
  await a1111.close();
  await rm(root, { recursive: true, force: true });
});

const think: Script = (_call, n) => ({
  params: {
    prompt: `girl, beach, sunset, take ${n + 1}`,
    negativePrompt: 'lowres',
    seed: 1234 + n,
    steps: 28,
    cfgScale: 7,
  },
  rationale: `${n + 1} 回目の案`,
});

/** stopAt 回目（1始まり）で「止めてよい」と言う見る役 */
function judge(stopAt: number): Script {
  return (call: LlmCall<unknown>, n) => ({
    images: call.messages.user
      .filter((part) => part.type === 'image')
      .map((_, i) => ({ score: 0.3 + n * 0.1 + i * 0.01, issues: ['背景が暗い'] })),
    nextChange: 'もっと逆光にする',
    canStop: n + 1 >= stopAt,
  });
}

function runnerFor(stopAt: number) {
  return new JobRunner({
    store,
    llm: new ScriptedLlm({ think, judge: judge(stopAt) }),
    backend,
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
  });
}

async function submit(conditions: AutoJobSpec['stopConditions']): Promise<AutoJobSpec> {
  const request = '夕暮れの海辺に立つ白いワンピースの少女';
  const spec = await store.createJob(
    { kind: 'auto', request, stopConditions: conditions, batchSize: 2 },
    { status: 'queued', carry: { intent: request, completedIterations: 0 } },
    new Date(),
  );
  if (spec.kind !== 'auto') throw new Error('auto のはず');
  return spec;
}

async function stopped(jobId: string): Promise<Extract<JobState, { status: 'stopped' }>> {
  const state = await store.readState(jobId);
  if (state.status !== 'stopped') throw new Error(`止まっていない: ${state.status}`);
  return state;
}

const posted = (path: string) =>
  a1111.requests
    .filter((r) => r.method === 'POST' && r.path === path)
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);

describe('the loop over the A1111 adapter', () => {
  it('runs think, generate and judge until the judge says the intent is met', async () => {
    const runner = runnerFor(2);
    const spec = await submit({ aiJudgement: true, maxIterations: 5 });
    runner.kick();
    await runner.idle();

    const state = await stopped(spec.jobId);
    expect(state.reason.kind).toBe('ai');
    expect(state.carry?.completedIterations).toBe(2);
    expect(state.imagesGenerated).toBe(4);

    // 考える役が決めた値が、そのまま A1111 の txt2img に届いている
    expect(posted('/sdapi/v1/txt2img')).toMatchObject([
      { prompt: 'girl, beach, sunset, take 1', seed: 1234, steps: 28, batch_size: 2 },
      { prompt: 'girl, beach, sunset, take 2', seed: 1235, steps: 28, batch_size: 2 },
    ]);
    // A1111 が返した画像と seed が、回の記録に残っている
    const second = await store.readGeneration(spec.jobId, 2);
    expect(second?.request.prompt).toBe('girl, beach, sunset, take 2');
    expect(second?.images.map((image) => image.seed)).toEqual([1235, 1236]);
  });

  it('stops at the iteration limit', async () => {
    const runner = runnerFor(99);
    const spec = await submit({ aiJudgement: true, maxIterations: 3 });
    runner.kick();
    await runner.idle();

    expect((await stopped(spec.jobId)).reason.kind).toBe('limit:iterations');
    expect(posted('/sdapi/v1/txt2img')).toHaveLength(3);
  });

  it('interrupts A1111 when a human stops the job during generation', async () => {
    // 中断されるまで txt2img に答えない A1111
    let release: (() => void) | undefined;
    a1111.route('POST /sdapi/v1/txt2img', (req, res) => {
      release = () => fakeTxt2img(req, res);
    });
    a1111.route('POST /sdapi/v1/interrupt', (req, res) => {
      json(200, {})(req, res);
      release?.();
    });
    const runner = runnerFor(99);
    const spec = await submit({ aiJudgement: true, maxIterations: 5 });
    runner.kick();
    while (release === undefined) await new Promise((r) => setTimeout(r, 5));
    await runner.stop(spec.jobId);
    await runner.idle();

    expect((await stopped(spec.jobId)).reason.kind).toBe('human');
    expect(posted('/sdapi/v1/interrupt')).toHaveLength(1);
  });

  it('runs a manual generation (M1) and keeps the images A1111 returned', async () => {
    const manual = new ManualGenerationRunner({ backend, store });
    const { jobId } = await manual.start({
      prompt: 'a cat',
      steps: 4,
      cfgScale: 7,
      seed: 42,
      width: 64,
      height: 64,
      batchSize: 2,
    });
    await manual.idle();

    expect((await stopped(jobId)).reason.kind).toBe('limit:iterations');
    const generation = await store.readGeneration(jobId, 1);
    expect(generation?.images.map((image) => image.seed)).toEqual([42, 43]);
    expect(posted('/sdapi/v1/txt2img')).toMatchObject([{ prompt: 'a cat', batch_size: 2 }]);
  });
});
