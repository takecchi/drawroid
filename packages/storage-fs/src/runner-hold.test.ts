// ジョブの LLM の段を待たせる口（holdLlmStages）と、人間がその回の画像を選ぶ口出し（adopt）を、
// 本物のファイルの置き場所の上で見る試験。LLM は台本、バックエンドはスタブで、
// 呼び出しを「合図まで返さない」形にした包みで、段の最中・生成の最中を決まって作る
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  type JobState,
  type StopConditions,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsJobStore } from './job-store.js';
import { blocking, GatedBackend } from './testing/hold-gates.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-hold-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = (_call, n) => ({
  params: {
    prompt: `girl, beach ${n + 1}`,
    negativePrompt: 'lowres',
    seed: 7 + n,
    steps: 20,
    cfgScale: 6,
  },
  rationale: '案',
  // 人間の指示を載せた回は、統合した要点を出させる
  intent: '海辺の少女、夕焼け',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

function setup(options: { think?: Script; judge?: Script; backend?: StubBackend }) {
  const store = new FsJobStore(root);
  const llm = new ScriptedLlm({ think: options.think ?? think, judge: options.judge ?? judge });
  const backend = options.backend ?? new StubBackend();
  const heldEvents: [string, boolean][] = [];
  const runner = new JobRunner({
    store,
    llm,
    backend,
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
    onLlmStagesHeld: (jobId, held) => heldEvents.push([jobId, held]),
  });
  return { store, llm, backend, runner, heldEvents };
}

async function submit(
  store: FsJobStore,
  stopConditions: StopConditions,
  batchSize = 1,
): Promise<string> {
  const spec = await store.createJob(
    { kind: 'auto', request: '海辺の少女', stopConditions, batchSize },
    { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
    new Date(),
  );
  return spec.jobId;
}

const stoppedReason = async (store: FsJobStore, jobId: string) => {
  const state: JobState = await store.readState(jobId);
  return state.status === 'stopped' ? state.reason.kind : state.status;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('holding the LLM stages of a running job', () => {
  it('aborts only the judge call that is in flight, keeps the job running, and judges again after release', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner, llm } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 1 });
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    const release = runner.holdLlmStages(jobId);
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));
    await tick();
    expect((await store.readState(jobId)).status).toBe('running');
    expect(await store.readStage(jobId, 1, 'judge')).toBeUndefined();

    release();
    await runner.idle();

    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(2);
    expect(judging.signals[1]!.aborted).toBe(false);
    expect(await store.readStage(jobId, 1, 'judge')).toMatchObject({ canStop: false });
    expect(await stoppedReason(store, jobId)).toBe('limit:iterations');
    expect(
      (await store.listLlmCalls(jobId)).filter((record) => record.purpose === 'judge'),
    ).toHaveLength(1);
  });

  it('does the same for the think call', async () => {
    const thinking = blocking(think, (n) => n === 0);
    const { store, runner, llm } = setup({ think: thinking.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 1 });
    runner.kick();
    await vi.waitFor(() => expect(thinking.signals).toHaveLength(1));

    const release = runner.holdLlmStages(jobId);
    await vi.waitFor(() => expect(thinking.signals[0]!.aborted).toBe(true));
    await tick();
    expect((await store.readState(jobId)).status).toBe('running');
    expect(await store.readStage(jobId, 1, 'think')).toBeUndefined();

    release();
    await runner.idle();

    expect(llm.calls.filter((c) => c.purpose === 'think')).toHaveLength(2);
    expect(await store.readStage(jobId, 1, 'think')).toMatchObject({ rationale: '案' });
    expect(await stoppedReason(store, jobId)).toBe('limit:iterations');
  });

  it('lets a generation in progress finish, then waits before the judge until released', async () => {
    const backend = new GatedBackend(true);
    const { store, runner, llm } = setup({ backend });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 1 });
    runner.kick();
    await vi.waitFor(() => expect(backend.generateSignals).toHaveLength(1));

    const release = runner.holdLlmStages(jobId);
    await tick();
    expect(backend.generateSignals[0]!.aborted).toBe(false);
    backend.openGenerate();
    await vi.waitFor(async () => expect(await store.listGenerations(jobId)).toHaveLength(1));
    await tick();

    expect(backend.interruptCount).toBe(0);
    expect(backend.generateSignals[0]!.aborted).toBe(false);
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(0);
    expect((await store.readState(jobId)).status).toBe('running');

    release();
    await runner.idle();

    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(1);
    expect(await stoppedReason(store, jobId)).toBe('limit:iterations');
  });

  it('stops by the human even while the stages are held', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner, heldEvents } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 3 });
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));
    runner.holdLlmStages(jobId);
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));
    await tick();

    await runner.stop(jobId);
    await runner.idle();

    expect(await stoppedReason(store, jobId)).toBe('human');
    expect(heldEvents).toEqual([
      [jobId, true],
      [jobId, false],
    ]);
  });

  it('waits until both of two overlapping holds are released', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner, heldEvents } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 1 });
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    const first = runner.holdLlmStages(jobId);
    const second = runner.holdLlmStages(jobId);
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));
    first();
    first();
    await tick();
    expect(judging.signals).toHaveLength(1);
    expect(heldEvents).toEqual([[jobId, true]]);

    second();
    await runner.idle();

    expect(judging.signals).toHaveLength(2);
    expect(heldEvents).toEqual([
      [jobId, true],
      [jobId, false],
    ]);
    expect(await stoppedReason(store, jobId)).toBe('limit:iterations');
  });

  it('tells the hook once when the wait starts and once when it ends', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner, heldEvents } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 1 });
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    const release = runner.holdLlmStages(jobId);
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));
    expect(heldEvents).toEqual([[jobId, true]]);
    release();
    await runner.idle();

    expect(heldEvents).toEqual([
      [jobId, true],
      [jobId, false],
    ]);
  });

  it('does nothing for a job that is not running, and still returns a release function', async () => {
    const { store, runner, heldEvents } = setup({});
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 1 });

    const release = runner.holdLlmStages(jobId);
    release();
    runner.kick();
    await runner.idle();

    expect(heldEvents).toEqual([]);
    expect(await stoppedReason(store, jobId)).toBe('limit:iterations');
  });
});

describe('adopting an image the human chose', () => {
  it('skips the judge for that iteration and carries the chosen image as the best, then takes in the instruction', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner, llm } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 2 }, 2);
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    const release = runner.holdLlmStages(jobId);
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));
    await runner.adopt(jobId, { iteration: 1, index: 1 });
    await runner.addInstruction(jobId, 'もっと夕焼けを赤く');
    release();
    await runner.idle();

    expect(await store.readStage(jobId, 1, 'judge')).toBeUndefined();
    expect(await store.readAdopted(jobId, 1)).toMatchObject({
      by: 'human',
      image: { iteration: 1, index: 1 },
      score: 1,
    });
    const judgeCalls = llm.calls.filter((c) => c.purpose === 'judge');
    expect(judgeCalls).toHaveLength(2);
    expect(judgeCalls.some((c) => c.signal.aborted)).toBe(true);
    const thinkCalls = llm.calls.filter((c) => c.purpose === 'think');
    expect(thinkCalls).toHaveLength(2);
    expect(JSON.stringify(thinkCalls[1]!.messages)).toContain('もっと夕焼けを赤く');
    const state = await store.readState(jobId);
    expect(state.carry?.best).toMatchObject({ iteration: 1, imageIndex: 1, score: 1 });
    expect(state.carry?.completedIterations).toBe(2);
    expect(await stoppedReason(store, jobId)).toBe('limit:iterations');
  });

  it('never calls the judge for the adopted iteration', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner, llm } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 2 });
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));
    const release = runner.holdLlmStages(jobId);
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));
    await runner.adopt(jobId, { iteration: 1, index: 0 });
    await runner.addInstruction(jobId, '次は横顔で');
    release();
    await runner.idle();

    // 見る役が呼ばれたのは、abort された1回と、2回目の回の1回だけ
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(2);
  });

  it('stops as adopted, without starting another iteration, when only the choice is given', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner, llm } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 5 });
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));
    const release = runner.holdLlmStages(jobId);
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));
    await runner.adopt(jobId, { iteration: 1, index: 0 });
    release();
    await runner.idle();

    expect(await stoppedReason(store, jobId)).toBe('adopted');
    expect(await store.listGenerations(jobId)).toHaveLength(1);
    expect(llm.calls.filter((c) => c.purpose === 'think')).toHaveLength(1);
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(1);
    expect((await store.readState(jobId)).carry?.best).toMatchObject({
      iteration: 1,
      imageIndex: 0,
      score: 1,
    });
  });

  it('makes an image of an already judged iteration the best and stops, when no instruction follows', async () => {
    const judging = blocking(judge, (n) => n === 1);
    const { store, runner } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 5 }, 2);
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(2));

    await runner.adopt(jobId, { iteration: 1, index: 1 });
    judging.answer(1);
    await runner.idle();

    expect(await stoppedReason(store, jobId)).toBe('adopted');
    expect(await store.readStage(jobId, 1, 'judge')).toBeDefined();
    expect(await store.readAdopted(jobId, 1)).toBeUndefined();
    expect((await store.readState(jobId)).carry?.best).toMatchObject({
      iteration: 1,
      imageIndex: 1,
      score: 1,
    });
  });

  it('cuts the judge call in flight for the chosen iteration, without holding the stages', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner, llm, heldEvents } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 5 });
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    await runner.adopt(jobId, { iteration: 1, index: 0 });
    await runner.idle();

    expect(judging.signals[0]!.aborted).toBe(true);
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(1);
    expect(await store.readAdopted(jobId, 1)).toMatchObject({ image: { iteration: 1, index: 0 } });
    expect(heldEvents).toEqual([]);
  });

  it('leaves the call in flight alone for a choice of an iteration the judge already saw', async () => {
    const judging = blocking(judge, (n) => n === 1);
    const { store, runner, llm } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 5 }, 2);
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(2));

    await runner.adopt(jobId, { iteration: 1, index: 1 });
    judging.answer(1);
    await runner.idle();

    expect(judging.signals[1]!.aborted).toBe(false);
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(2);
  });

  it('refuses an image that does not exist, and writes nothing', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { store, runner } = setup({ judge: judging.script });
    const jobId = await submit(store, { aiJudgement: false, maxIterations: 1 });
    runner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    await expect(runner.adopt(jobId, { iteration: 1, index: 3 })).rejects.toThrow();
    await expect(runner.adopt(jobId, { iteration: 2, index: 0 })).rejects.toThrow();
    expect(await store.listInterventions(jobId)).toEqual([]);

    judging.answer(0);
    await runner.idle();
  });
});
