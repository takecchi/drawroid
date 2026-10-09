// review_image: 評価済みの画像は呼ばずに返し、評価の無い画像だけ見る役を1回呼び、同じ画像を2回渡さないことを見る。
// ジョブの置き場所は、このツールが使う口だけの置き換え。LLM は台本どおりに返すスタブ
import { describe, expect, it } from 'vitest';

import { DEFAULT_BUDGETS } from '../budget/settings.js';
import type { JobState } from '../job/types.js';
import type { LlmCallRecord } from '../llm/record.js';
import { createCarry } from '../loop/carry.js';
import { buildJudgeInput } from '../loop/inputs.js';
import { ScriptedLlm, STUB_PNG, type Script } from '../testing/index.js';
import { describeJudgement } from './drawing.js';
import { createReviewTools, type ReviewToolDeps } from './review-tools.js';
import { DEFAULT_TALK_LIMITS } from './talk/limits.js';
import { TALK_TOOL_DESCRIPTION_MAX_CHARS, type TalkToolContext } from './talk/tools.js';

const CONVERSATION = 'conv-1';

type FakeJob = {
  spec: Record<string, unknown>;
  state: JobState;
  iterations: number[];
  judged: Map<number, unknown>;
  adopted: Set<number>;
  interventions: { kind: 'adopt'; image: { iteration: number; index: number } }[];
};

function fakeJobs(jobs: Record<string, FakeJob>) {
  const calls: LlmCallRecord[] = [];
  const sent = new Map<string, string>();
  const store = {
    listJobIds: async () => Object.keys(jobs),
    readJob: async (id: string) => {
      const job = jobs[id];
      if (job === undefined) throw new Error('no job');
      return job.spec;
    },
    readState: async (id: string) => jobs[id]!.state,
    listGenerations: async (id: string) => jobs[id]!.iterations.map((iteration) => ({ iteration })),
    readGeneration: async (id: string, iteration: number) =>
      jobs[id]!.iterations.includes(iteration) ? { iteration, images: [{}, {}] } : undefined,
    readStage: async (id: string, iteration: number) => jobs[id]!.judged.get(iteration),
    readAdopted: async (id: string, iteration: number) =>
      jobs[id]!.adopted.has(iteration) ? { by: 'human' } : undefined,
    listInterventions: async (id: string) => jobs[id]!.interventions,
    loadPreview: async (
      image: { jobId: string; iteration: number; index: number },
      longEdge: number,
    ) => ({
      key: `${image.iteration}-${image.index}`,
      data: STUB_PNG,
      mediaType: 'image/png',
      longEdge: Math.min(longEdge, 64),
      ...(sent.has(`${image.jobId}/${image.iteration}-${image.index}`) && {
        sentInCall: sent.get(`${image.jobId}/${image.iteration}-${image.index}`),
      }),
    }),
    markSent: async (
      image: { jobId: string; iteration: number; index: number },
      callId: string,
    ) => {
      sent.set(`${image.jobId}/${image.iteration}-${image.index}`, callId);
    },
    writeLlmCall: async (record: LlmCallRecord) => {
      calls.push(record);
    },
    listLlmCallRecords: async () => ({ records: calls, invalid: [] }),
  };
  return { store: store as unknown as ReviewToolDeps['jobs'], calls };
}

const runningState = (): JobState => ({
  status: 'running',
  startedAt: '2026-10-09T00:00:00.000Z',
  imagesGenerated: 4,
  carry: createCarry('夕暮れの海辺', DEFAULT_BUDGETS).carry,
});
const stoppedState = (): JobState => ({
  status: 'stopped',
  stoppedAt: '2026-10-09T00:10:00.000Z',
  imagesGenerated: 4,
  carry: createCarry('夕暮れの海辺', DEFAULT_BUDGETS).carry,
  reason: { kind: 'limit:iterations', detail: '2 回' },
});
const job = (state: JobState, patch: Partial<FakeJob> = {}): FakeJob => ({
  spec: { kind: 'auto', jobId: 'job-1', conversationId: CONVERSATION },
  state,
  iterations: [1, 2],
  judged: new Map(),
  adopted: new Set(),
  interventions: [],
  ...patch,
});

const judgeScript: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.7, issues: ['手が崩れている'] })),
  nextChange: '手を直す',
  canStop: false,
});

function setup(jobs: Record<string, FakeJob>, script: Script = judgeScript) {
  const { store, calls } = fakeJobs(jobs);
  const llm = new ScriptedLlm({ judge: script });
  let n = 0;
  const [tool] = createReviewTools({
    jobs: store,
    llm: () => llm,
    budgets: async () => DEFAULT_BUDGETS,
    newCallId: () => `call-${++n}`,
    now: () => new Date('2026-10-09T06:30:12.000Z'),
  });
  const context = (signal = new AbortController().signal): TalkToolContext => ({
    conversationId: CONVERSATION,
    turn: 1,
    events: [],
    limits: DEFAULT_TALK_LIMITS,
    signal,
  });
  const review = (input: unknown, signal?: AbortSignal) =>
    tool!.run(tool!.inputSchema.parse(input), context(signal));
  return { tool: tool!, review, llm, calls };
}

describe('review_image', () => {
  it('returns the evaluation the loop already wrote, as the fixed sentence, without calling the judge', async () => {
    const judged = {
      images: [
        { score: 0.9, issues: [] },
        { score: 0.4, issues: ['色が濁る'] },
      ],
      nextChange: '色を澄ませる',
      canStop: false,
    };
    const { review, llm } = setup({
      'job-1': job(runningState(), { judged: new Map([[1, judged]]) }),
    });

    const result = await review({ iteration: 1, index: 1 });

    expect(result.ok).toBe(true);
    expect(result.result).toContain(
      describeJudgement({
        images: [{ index: 1, score: 0.4, issues: ['色が濁る'] }],
        nextChange: '色を澄ませる',
        canStop: false,
      }),
    );
    expect(llm.calls).toHaveLength(0);
  });

  it('calls the judge once for an image nobody evaluated, with its one preview only, and records the call', async () => {
    const { review, llm, calls } = setup({ 'job-1': job(stoppedState()) });

    const result = await review({ iteration: 2, index: 1 });

    expect(result).toMatchObject({ ok: true });
    expect(result.result).toContain('2枚目は 0.70（手が崩れている）');
    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0]!;
    expect(call.role).toBe('judge');
    expect(call.messages.user.filter((part) => part.type === 'image')).toEqual([
      expect.objectContaining({ key: '2-1' }),
    ]);
    expect(call.schema.safeParse({ images: [], nextChange: '', canStop: false }).success).toBe(
      false,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      jobId: 'job-1',
      iteration: 2,
      role: 'judge',
      purpose: 'judge',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it('judges an image of the iteration the human adopted, which the loop did not judge, while the job runs', async () => {
    const { review, llm } = setup({ 'job-1': job(runningState(), { adopted: new Set([2]) }) });

    expect(await review({ iteration: 2 })).toMatchObject({ ok: true });
    expect(llm.calls).toHaveLength(1);
  });

  it('returns the first evaluation, without calling the judge, when the same image is asked again', async () => {
    const { review, llm } = setup({ 'job-1': job(stoppedState()) });

    const first = await review({ iteration: 2, index: 0 });
    const second = await review({ iteration: 2, index: 0 });

    expect(llm.calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('says the image is still being evaluated, without calling the judge, while the loop judges its iteration', async () => {
    const { review, llm, calls } = setup({ 'job-1': job(runningState()) });

    const result = await review({ iteration: 2 });

    expect(result.ok).toBe(false);
    expect(result.result).toContain('まだ評価中');
    expect(llm.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('defaults to the latest iteration and the first image, like adopt_image', async () => {
    const { review, llm } = setup({ 'job-1': job(stoppedState()) });

    await review({});

    expect(llm.calls[0]!.messages.user.filter((part) => part.type === 'image')).toEqual([
      expect.objectContaining({ key: '2-0' }),
    ]);
  });

  it.each([
    ['an iteration that does not exist', { iteration: 9 }, '画像 9-0 は無い'],
    ['an image that does not exist', { iteration: 1, index: 5 }, '画像 1-5 は無い'],
    ['a job of another conversation', { jobId: 'other', iteration: 1 }, 'この会話のジョブではない'],
    ['a job that does not exist', { jobId: 'nothing', iteration: 1 }, 'この会話のジョブではない'],
  ])('refuses %s, saying what is wrong, without calling the judge', async (_, input, message) => {
    const { review, llm } = setup({
      'job-1': job(stoppedState()),
      other: {
        ...job(stoppedState()),
        spec: { kind: 'auto', jobId: 'other', conversationId: 'conv-2' },
      },
    });

    const result = await review(input);

    expect(result.ok).toBe(false);
    expect(result.result).toContain(message);
    expect(llm.calls).toHaveLength(0);
  });

  it('refuses when the conversation has drawn nothing', async () => {
    const { review, llm } = setup({});

    expect(await review({})).toMatchObject({ ok: false });
    expect(llm.calls).toHaveLength(0);
  });

  it('stops the judge call when the signal aborts', async () => {
    const controller = new AbortController();
    const { review, calls } = setup(
      { 'job-1': job(stoppedState()) },
      () => new Promise(() => undefined),
    );

    const pending = review({ iteration: 1 }, controller.signal);
    controller.abort(new Error('stop'));

    await expect(pending).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('builds the judge input like the loop does, within the budget of the job', async () => {
    const { review, llm } = setup({ 'job-1': job(stoppedState()) });

    await review({ iteration: 1 });

    const carry = createCarry('夕暮れの海辺', DEFAULT_BUDGETS).carry;
    const expected = buildJudgeInput({
      carry,
      images: [{ key: '1-0', data: STUB_PNG, mediaType: 'image/png', longEdge: 64 }],
      budget: DEFAULT_BUDGETS,
      window: llm.describe('judge').window,
    });
    const actual = llm.calls[0]!.messages;
    expect(actual.system).toBe(expected.system);
    expect(actual.user.map((part) => (part.type === 'text' ? part.text : part.key))).toEqual(
      expected.user.map((part) => (part.type === 'text' ? part.text : part.key)),
    );
    expect(actual.report.estimatedInputTokens).toBeLessThanOrEqual(actual.report.inputTokenLimit);
  });

  it('says when to call it in its definition, within the description budget', () => {
    const { tool } = setup({});

    expect(tool.name).toBe('review_image');
    expect(tool.description).toContain('「この絵どう？」');
    expect(tool.description).toContain('評価済み');
    expect(tool.description.length).toBeLessThanOrEqual(TALK_TOOL_DESCRIPTION_MAX_CHARS);
  });
});
