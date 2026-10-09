// 人間の好み（記憶）が考える役・見る役の入力に載り、止まったジョブから学んだ好みが次のジョブの見る役に効くことを、
// 本物のファイルの置き場所で見る試験。LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  type LlmCall,
  type MemoryItem,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFsDistillLog } from './distill/log.js';
import { FsJobStore } from './job-store.js';
import { createFsMemoryStore } from './memory/store.js';
import { dataPaths } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-memory-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const FINGERS = '指の崩れは許容しない';
const now = '2026-01-01T00:00:00+09:00';
const item = (id: string, body: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  body,
  tags: [],
  scope: 'always',
  sources: [],
  createdAt: now,
  updatedAt: now,
  ...extra,
});

const think: Script = () => ({
  params: {
    prompt: 'girl, beach, sunset',
    negativePrompt: 'lowres',
    seed: 7,
    steps: 20,
    cfgScale: 6,
    loras: [],
  },
  rationale: '案',
  // 口出しのある回だけ求められる欄。無い回では捨てられる
  intent: '夕暮れの海辺の少女。指を丁寧に',
});
const judgeScript =
  (canStop: boolean): Script =>
  (call) => ({
    images: call.messages.user
      .filter((part) => part.type === 'image')
      .map(() => ({ score: 0.9, issues: [] })),
    nextChange: 'なし',
    canStop,
  });

const textOf = (call: LlmCall<unknown> | undefined) =>
  (call?.messages.user ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');

function setup(scripts: { think?: Script; judge?: Script; distill?: Script } = {}) {
  const store = new FsJobStore(root);
  const memoryStore = createFsMemoryStore(dataPaths(root).memory);
  const distillLog = createFsDistillLog(root);
  const llm = new ScriptedLlm({
    think: scripts.think ?? think,
    judge: scripts.judge ?? judgeScript(true),
    distill: scripts.distill ?? (() => ({ operations: [] })),
  });
  const logs: string[] = [];
  const runner = new JobRunner({
    store,
    llm,
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 512, height: 512 }),
    memory: { store: memoryStore, distillLog },
    log: (line) => logs.push(line),
  });
  const submit = (request: string, maxIterations = 1) =>
    store.createJob(
      {
        kind: 'auto',
        request,
        stopConditions: { aiJudgement: true, maxIterations },
        batchSize: 1,
      },
      { status: 'queued', carry: { intent: request, completedIterations: 0 } },
      new Date(),
    );
  const callsOf = (purpose: string) => llm.calls.filter((c) => c.purpose === purpose);
  return { store, memoryStore, distillLog, llm, runner, submit, callsOf, logs };
}

describe('the preferences in memory reach the thinking and the judging roles', () => {
  it('puts a preference in the input of the judging role', async () => {
    const { memoryStore, runner, submit, callsOf } = setup();
    await memoryStore.put(item('fingers', FINGERS));
    await submit('夕暮れの海辺の少女');

    runner.kick();
    await runner.idle();

    expect(textOf(callsOf('judge')[0])).toContain(FINGERS);
  });

  it('puts a preference in the input of the thinking role', async () => {
    const { memoryStore, runner, submit, callsOf } = setup();
    await memoryStore.put(item('fingers', FINGERS));
    await submit('夕暮れの海辺の少女');

    runner.kick();
    await runner.idle();

    expect(textOf(callsOf('think')[0])).toContain(FINGERS);
  });

  it('records the preferences left out by the budget in the record of the call', async () => {
    const { memoryStore, runner, submit, callsOf } = setup();
    for (let n = 0; n < 12; n++) await memoryStore.put(item(`always-${n}`, `好み${n}`.padEnd(30)));
    await submit('夕暮れの海辺の少女');

    runner.kick();
    await runner.idle();

    expect(callsOf('judge')[0]?.messages.report.notes).toContainEqual(
      expect.objectContaining({ kind: 'dropped', section: expect.stringMatching(/^memory\[/) }),
    );
  });

  it('shows an edit a human made during a round from the next round on', async () => {
    const memoryStore = createFsMemoryStore(dataPaths(root).memory);
    let edited = false;
    const { runner, submit, callsOf } = setup({
      think: (call, n) => {
        if (n === 0 && !edited) {
          edited = true;
          void memoryStore.put(item('fingers', '背景の人物は描かない'));
        }
        return think(call, n);
      },
      judge: judgeScript(false),
    });
    await memoryStore.put(item('fingers', FINGERS));
    await submit('夕暮れの海辺の少女', 2);

    runner.kick();
    await runner.idle();

    const [firstJudge, secondJudge] = callsOf('judge');
    expect(textOf(firstJudge)).toContain(FINGERS);
    expect(textOf(secondJudge)).toContain('背景の人物は描かない');
    expect(textOf(secondJudge)).not.toContain(FINGERS);
    expect(textOf(callsOf('think')[1])).toContain('背景の人物は描かない');
  });
});

describe('a stopped job leaves what it taught to the next job', () => {
  const teachFingers: Script = () => ({
    operations: [{ op: 'add', body: FINGERS, tags: [], scope: 'always' }],
  });

  it('writes the learned preference to memory, which the judging role of the next job sees', async () => {
    const { store, memoryStore, distillLog, runner, submit, callsOf } = setup({
      distill: teachFingers,
    });
    const first = await submit('夕暮れの海辺の少女');
    await runner.addInstruction(first.jobId, '指の崩れは許さない');
    runner.kick();
    await runner.idle();

    expect(callsOf('distill')).toHaveLength(1);
    expect((await memoryStore.list()).items.map((i) => i.body)).toEqual([FINGERS]);
    const [entry] = await distillLog.read(first.jobId);
    expect(entry?.applied).toHaveLength(1);
    const calls = await store.listLlmCalls(first.jobId);
    expect(calls.filter((c) => c.purpose === 'distill')).toEqual([
      expect.objectContaining({ role: 'think', iteration: null, callId: entry?.callId }),
    ]);

    const second = await submit('雨の街角の猫');
    runner.kick();
    await runner.idle();

    const judgeOfSecond = callsOf('judge').at(-1);
    expect(textOf(judgeOfSecond)).toContain(FINGERS);
    expect((await store.readState(second.jobId)).status).toBe('stopped');
  });

  it('learns from a job a human stopped while it was still waiting', async () => {
    const { memoryStore, runner, submit } = setup({ distill: teachFingers });
    const waiting = await submit('夕暮れの海辺の少女');
    await runner.addInstruction(waiting.jobId, '指の崩れは許さない');

    await runner.stop(waiting.jobId);

    expect((await memoryStore.list()).items.map((i) => i.body)).toEqual([FINGERS]);
  });

  it('does not call the distillation for a job with neither instructions nor selections', async () => {
    const { runner, submit, callsOf } = setup();
    await submit('夕暮れの海辺の少女');

    runner.kick();
    await runner.idle();

    expect(callsOf('distill')).toHaveLength(0);
  });

  it('keeps the reason the job stopped for when the distillation answers badly', async () => {
    const { store, memoryStore, runner, submit } = setup({
      distill: () => ({ operations: 'nonsense' }),
    });
    const job = await submit('夕暮れの海辺の少女');
    await runner.addInstruction(job.jobId, '指の崩れは許さない');

    runner.kick();
    await runner.idle();

    const state = await store.readState(job.jobId);
    expect(state.status === 'stopped' && state.reason.kind).toBe('ai');
    expect((await memoryStore.list()).items).toEqual([]);
  });

  it('keeps the reason the job stopped for when the distillation throws', async () => {
    const { store, runner, submit, logs } = setup({
      distill: () => {
        throw new Error('LLM が落ちた');
      },
    });
    const job = await submit('夕暮れの海辺の少女');
    await runner.addInstruction(job.jobId, '指の崩れは許さない');

    runner.kick();
    await runner.idle();

    const state = await store.readState(job.jobId);
    expect(state.status === 'stopped' && state.reason.kind).toBe('ai');
    expect(logs.join('\n')).toContain('LLM が落ちた');
  });
});
