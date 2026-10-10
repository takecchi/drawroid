// 見る役が、点数の低いまま「止めてよい」と返したときに、ジョブがそれを止める理由として読まないことを見る試験。
// LLM は台本どおりに返すスタブ（聞き直しはしない。聞き直しの回数は packages/llm の試験で見る）、バックエンドは M1 のスタブ
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { basicPermissions, DEFAULT_BUDGET, JobRunner } from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-judge-consistency-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: {
    prompt: 'girl, beach, sunset',
    negativePrompt: 'lowres',
    seed: 7,
    steps: 20,
    cfgScale: 6,
  },
  rationale: '案',
});

/** 2026-10-09 の実機（llama.cpp・Qwen2.5-VL-3B）で見る役が返した形: 点数 0 のまま canStop が true */
const judgeSaying =
  (score: number, canStop: boolean): Script =>
  () => ({
    images: [{ score, issues: score < 0.5 ? ['海辺も少女も描かれていない'] : [] }],
    nextChange: score < 0.5 ? '海辺に立つ少女を描く' : '',
    canStop,
  });

async function runWith(judge: Script) {
  const store = new FsJobStore(root);
  const llm = new ScriptedLlm({ think, judge });
  const runner = new JobRunner({
    store,
    llm,
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 512, height: 512 }),
  });
  const request = '夕暮れの海辺に立つ少女';
  const spec = await store.createJob(
    {
      kind: 'auto',
      request,
      stopConditions: { aiJudgement: true, maxIterations: 3 },
      batchSize: 1,
    },
    { status: 'queued', carry: { intent: request, completedIterations: 0 } },
    new Date(),
  );
  runner.kick();
  await runner.idle();
  return { state: await store.readState(spec.jobId), llm };
}

describe('a judge that says it can stop with a low score', () => {
  it('stops the job as an error with the reason, not as the intent being met', async () => {
    const { state, llm } = await runWith(judgeSaying(0, true));

    expect(state).toMatchObject({
      status: 'stopped',
      reason: { kind: 'error', detail: expect.stringContaining('canStop') as unknown },
    });
    expect(llm.calls.filter((call) => call.purpose === 'judge')).toHaveLength(1);
  });

  it('stops the job as an error at a best score of 0.49', async () => {
    const { state } = await runWith(judgeSaying(0.49, true));

    expect(state).toMatchObject({ status: 'stopped', reason: { kind: 'error' } });
  });

  it('stops the job as the intent being met at a best score of 0.5', async () => {
    const { state } = await runWith(judgeSaying(0.5, true));

    expect(state).toMatchObject({ status: 'stopped', reason: { kind: 'ai' } });
  });

  it('goes on to the next round when a low score does not say it can stop', async () => {
    const { state, llm } = await runWith(judgeSaying(0, false));

    expect(state).toMatchObject({ status: 'stopped', reason: { kind: 'limit:iterations' } });
    expect(llm.calls.filter((call) => call.purpose === 'judge')).toHaveLength(3);
  });
});
