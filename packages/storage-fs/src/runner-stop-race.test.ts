// 人間の停止（JobRunner.stop）が、ランナーがジョブを拾ってから「走っている」と書くまでの窓に来ても、
// ジョブが止まった状態のままで回り続けないことを見る試験。窓は、停止の側の状態の読み出しを門で待たせて、決まって作る。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ、置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { basicPermissions, DEFAULT_BUDGET, JobRunner, type JobStore } from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-stop-race-'));
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
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

/** 次の readState を、読んだ値を持ったまま、試験が開けるまで返さない置き場所（読んだあとで状態が変わる窓を作る） */
function gatedStore(inner: JobStore) {
  let armed = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'readState') {
        return async (jobId: string) => {
          const state = await target.readState(jobId);
          if (armed) {
            armed = false;
            await gate;
          }
          return state;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { store, arm: () => (armed = true), release: () => release() };
}

async function untilRunning(store: JobStore, jobId: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while ((await store.readState(jobId)).status !== 'running') {
    if (Date.now() > deadline) throw new Error(`${jobId} が走り始めない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('stopping a job while the runner is picking it up', () => {
  it('leaves the job stopped by the human, instead of letting it run on', async () => {
    const files = new FsJobStore(root);
    const gated = gatedStore(files);
    const runner = new JobRunner({
      store: gated.store,
      llm: new ScriptedLlm({ think, judge }),
      backend: new StubBackend(),
      budget: DEFAULT_BUDGET,
      permissions: basicPermissions({ width: 64, height: 64 }),
    });
    // 窓が開いたままでも試験が終わるよう、回数で止まるようにしておく（回り続けたら、この回数まで回る）
    const spec = await files.createJob(
      {
        kind: 'auto',
        request: '海辺の少女',
        stopConditions: { aiJudgement: false, maxIterations: 5 },
        batchSize: 1,
      },
      { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
      new Date(),
    );

    // 停止の側が「待っている」と読んだところで止めておき、その間にランナーがジョブを拾って走り始める
    gated.arm();
    const stopping = runner.stop(spec.jobId);
    runner.kick();
    await untilRunning(files, spec.jobId);
    gated.release();
    await stopping;
    await runner.idle();

    expect(await files.readState(spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'human' },
    });
    expect((await files.listGenerations(spec.jobId)).length).toBeLessThan(5);
  });
});
