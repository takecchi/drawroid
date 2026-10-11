// ジョブの投入（JobRunner.kick）が、ランナーが「次のジョブは無い」と読み終えた直後に来ても、そのジョブが
// 待ち行列に取り残されないことを見る試験。窓は、置き場所の一覧の読み出しを門で待たせて、決まって作る。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ、置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  type GenerationRequest,
  type GenerationResult,
  type JobStore,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-kick-race-'));
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

/** 次の listJobIds を、読んだ値を持ったまま、試験が開けるまで返さない置き場所（読んだあとでジョブが増える窓を作る） */
function gatedStore(inner: JobStore) {
  let armed = false;
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const scanned = new Promise<void>((resolve) => (reached = resolve));
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'listJobIds') {
        return async () => {
          const ids = await target.listJobIds();
          if (armed) {
            armed = false;
            reached();
            await gate;
          }
          return ids;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { store, arm: () => (armed = true), scanned, release: () => release() };
}

/** 同時に generate の中にいる数の最大を数えるバックエンド */
class CountingBackend extends StubBackend {
  maxConcurrent = 0;
  private concurrent = 0;
  override async generate(
    req: GenerationRequest,
    signal: AbortSignal,
    inputs?: Parameters<StubBackend['generate']>[2],
  ): Promise<GenerationResult> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      // 他のジョブが走っていれば、ここで重なる
      await new Promise((resolve) => setImmediate(resolve));
      return await super.generate(req, signal, inputs);
    } finally {
      this.concurrent -= 1;
    }
  }
}

function setup(backend: StubBackend = new StubBackend()) {
  const files = new FsJobStore(root);
  const gated = gatedStore(files);
  const runner = new JobRunner({
    store: gated.store,
    llm: new ScriptedLlm({ think, judge }),
    backend,
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
  });
  const submit = () =>
    files.createJob(
      {
        kind: 'auto',
        request: '海辺の少女',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
      },
      { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
      new Date(),
    );
  return { files, gated, runner, submit };
}

describe('submitting a job while the runner is finishing its last scan', () => {
  it('still runs a job submitted right after the runner found the queue empty', async () => {
    const { files, gated, runner, submit } = setup();

    // 待ち行列が空のまま走査が終わったところで止めておき、その間にジョブを投入して合図する
    gated.arm();
    runner.kick();
    await gated.scanned;
    const spec = await submit();
    runner.kick();
    gated.release();
    await runner.idle();

    expect(await files.readState(spec.jobId)).toMatchObject({ status: 'stopped' });
  });

  it('runs one job at a time even when kicked repeatedly while jobs wait', async () => {
    const backend = new CountingBackend();
    const { files, runner, submit } = setup(backend);

    const specs = [await submit(), await submit(), await submit()];
    for (let i = 0; i < 5; i += 1) runner.kick();
    await runner.idle();

    for (const spec of specs) {
      expect(await files.readState(spec.jobId)).toMatchObject({ status: 'stopped' });
    }
    expect(backend.maxConcurrent).toBe(1);
  });

  it('settles idle once the queue is empty, however often it was kicked', async () => {
    const { files, runner, submit } = setup();

    const spec = await submit();
    runner.kick();
    runner.kick();
    await runner.idle();
    runner.kick();
    await runner.idle();

    expect(await files.readState(spec.jobId)).toMatchObject({ status: 'stopped' });
  });
});
