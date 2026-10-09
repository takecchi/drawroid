// 考える役の入力の「進み具合」に、止める条件の残り（回数・枚数・時間）が載ることを、
// 本物のファイルの置き場所の上で JobRunner を回して見る試験。時計は止めて、経った時間を回ごとに進める
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  type LlmCall,
  type StopConditions,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-progress-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = (_call, n) => ({
  params: { prompt: `girl ${n}`, negativePrompt: 'lowres', seed: n, steps: 20, cfgScale: 6 },
  rationale: '案',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

/** 考える役の入力のうち、進み具合の行 */
const progressLine = (call: LlmCall<unknown>) =>
  call.messages.user
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .split('\n')
    .find((line) => line.startsWith('これから'));

async function run(stopConditions: StopConditions, minutesPerIteration = 0) {
  const store = new FsJobStore(root);
  let t = Date.parse('2026-10-09T00:00:00Z');
  // 見る役を呼ぶたびに時計を進める: 回ごとに経った時間を決まった量にするため
  const llm = new ScriptedLlm({
    think,
    judge: (call, n) => {
      t += minutesPerIteration * 60_000;
      return judge(call, n);
    },
  });
  const runner = new JobRunner({
    store,
    llm,
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
    now: () => new Date(t),
  });
  await store.createJob(
    { kind: 'auto', request: '海辺の少女', stopConditions, batchSize: 2 },
    { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
    new Date(t),
  );
  runner.kick();
  await runner.idle();
  return llm.calls.filter((call) => call.purpose === 'think').map(progressLine);
}

describe('the progress shown to the think role', () => {
  it('shows the remaining iterations, images and time, each counted down by the iterations done', async () => {
    const lines = await run(
      { aiJudgement: false, maxIterations: 3, maxImages: 6, maxDurationMs: 10 * 60_000 },
      2,
    );
    expect(lines).toEqual([
      expect.stringMatching(/^これから 1 回目（残り 3 回・6 枚・約 10 分）。/),
      expect.stringMatching(/^これから 2 回目（残り 2 回・4 枚・約 8 分）。/),
      expect.stringMatching(/^これから 3 回目（残り 1 回・2 枚・約 6 分）。/),
    ]);
  });

  it('leaves out the remaining images and time when the stop conditions do not have them', async () => {
    const lines = await run({ aiJudgement: false, maxIterations: 2 });
    expect(lines).toEqual([
      expect.stringMatching(/^これから 1 回目（残り 2 回）。/),
      expect.stringMatching(/^これから 2 回目（残り 1 回）。/),
    ]);
  });

  it('shows only the remaining images when the stop conditions have only an image limit', async () => {
    const lines = await run({ aiJudgement: false, maxImages: 3 });
    expect(lines).toEqual([
      expect.stringMatching(/^これから 1 回目（残り 3 枚）。/),
      expect.stringMatching(/^これから 2 回目（残り 1 枚）。/),
    ]);
  });
});
