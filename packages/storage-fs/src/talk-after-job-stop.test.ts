// 会話で描いた絵が描き終わったら（ジョブが AI の判断・上限・エラーで止まったら）、話す役から1度だけ話しかけることを、
// 会話の実行器・ジョブの実行器・橋渡しを本物どおりにつないで見る試験。人が止めた・選んだときと、再起動のあとは話しかけない。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ、置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  backfillJobEvents,
  basicPermissions,
  bridgeJobEvents,
  closeInterruptedTurns,
  ConversationHubs,
  createDrawingTools,
  DEFAULT_BUDGET,
  DEFAULT_BUDGETS,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  jobSummaryFor,
  RESTART_REASON,
  TalkRunner,
  type ConversationEvent,
  type JobStore,
  type StopConditions,
  type TalkStepCall,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script, type TalkScript } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsConversationStore } from './conversation-store.js';
import { FsJobStore } from './job-store.js';

/** 話しかけるターン・ジョブの止まりが確定するまで待つ上限 */
const TIMEOUT_MS = 5_000;
/** 話しかけないことを見るときに、何も起きないのを待つ長さ */
const QUIET_MS = 300;
/** 1つの試験の上限。待ちを何度か重ねても、TIMEOUT_MS の待ちが試験の上限より先に切れるようにする */
const TEST_TIMEOUT_MS = 20_000;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-talk-after-job-stop-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const permissions = basicPermissions({ width: 64, height: 64 });

const think: Script = () => ({
  params: {
    prompt: 'girl, beach, sunset',
    negativePrompt: 'lowres',
    seed: 7,
    steps: 20,
    cfgScale: 6,
  },
  rationale: '夕暮れの光を足す',
});
/** 2回目の評価で「止めてよい」と言う見る役 */
const judgeDoneAtTwo: Script = (call, n) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => (n >= 1 ? { score: 0.92, issues: [] } : { score: 0.55, issues: ['空が暗い'] })),
  nextChange: n >= 1 ? '' : '空をもう少し赤く',
  canStop: n >= 1,
});
const judgeNeverDone: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.6, issues: ['空が暗い'] })),
  nextChange: '空をもう少し赤く',
  canStop: false,
});
/** 形の合わない評価を返す見る役（見る段の失敗でジョブが止まる） */
const judgeBroken: Script = () => ({ images: 'よく描けている', canStop: 'はい' });

const textOf = (call: TalkStepCall) =>
  call.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

/** 本物のモデルと同じく、思考を出し、本文は思考のあとの改行から始める */
const REPORT = '描き終わりました。最良は 2 回目の 1枚目です。';
function talkScript(stopConditions: StopConditions, report?: () => Promise<void>): TalkScript {
  return async (call) => {
    if (call.tools.length === 0) {
      await report?.();
      return { reasoning: 'ジョブが止まったので、結果を伝える。', text: `\n\n${REPORT}` };
    }
    if (textOf(call).includes('ツール start_drawing')) return { text: '描き始めました。' };
    return {
      reasoning: '描く指示なので start_drawing を呼ぶ。',
      text: '描きます。',
      toolCalls: [
        { name: 'start_drawing', input: { request: '夕暮れの海辺に立つ少女', stopConditions } },
      ],
    };
  };
}

/** 1つのプロセスぶんの組み立て（cli の index.ts と同じつなぎ方） */
function startProcess(options: {
  judge: Script;
  stopConditions: StopConditions;
  /** false なら、止まりを話す役へ知らせない（job.stopped を確定した直後に落ちたプロセスの代わり） */
  wired?: boolean;
  /** 話しかけるステップを、この約束が解けるまで返さない */
  report?: () => Promise<void>;
}) {
  const conversations = new FsConversationStore(root);
  const hubs = new ConversationHubs({ store: conversations });
  const jobs: JobStore = bridgeJobEvents(new FsJobStore(root), {
    hubs,
    onStopped: (stop) => {
      if (options.wired !== false) talk.reportJobStopped(stop);
    },
  });
  const llm = new ScriptedLlm(
    { think, judge: options.judge },
    { talk: talkScript(options.stopConditions, options.report) },
  );
  const jobRunner = new JobRunner({
    store: jobs,
    llm,
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions,
  });
  const talk = new TalkRunner({
    store: conversations,
    hubs,
    llm: () => llm,
    tools: createDrawingTools({
      jobs,
      runner: jobRunner,
      conversations,
      humanPermissions: async () => permissions,
      candidateNames: async () => [],
      defaultStopConditions: async () => ({ aiJudgement: true, maxIterations: 10 }),
      budgets: async () => DEFAULT_BUDGETS,
      now: () => new Date(),
    }),
    limits: async () => DEFAULT_TALK_LIMITS,
    jobSummary: jobSummaryFor({ jobs, chars: async () => DEFAULT_TALK_LIMITS.jobChars }),
  });
  return { conversations, hubs, jobs, llm, jobRunner, talk };
}

type Process = ReturnType<typeof startProcess>;

async function askForDrawing(p: Process) {
  const { conversationId } = await p.conversations.createConversation(new Date());
  await p.hubs
    .get(conversationId)
    .confirm({ type: 'user.message', text: '夕暮れの海辺の少女を描いて', attachments: [] });
  p.talk.kick(conversationId);
  return conversationId;
}

const eventsOf = async (p: Pick<Process, 'conversations'>, conversationId: string) =>
  (await p.conversations.readEvents(conversationId, { limit: 1000 })).events;

const jobTurnsOf = (events: ConversationEvent[]) =>
  events.filter(
    (e): e is Extract<ConversationEvent, { type: 'turn.started' }> =>
      e.type === 'turn.started' && 'jobId' in e && e.jobId !== undefined,
  );

async function waitForEvent(
  p: Pick<Process, 'conversations'>,
  conversationId: string,
  found: (event: ConversationEvent) => boolean,
) {
  await vi.waitFor(async () => expect((await eventsOf(p, conversationId)).some(found)).toBe(true), {
    timeout: TIMEOUT_MS,
  });
}

const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

describe(
  'speaking up after a drawing of the conversation finishes',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('speaks once after the job stops on the judge, and not on the iterations before', async () => {
      const p = startProcess({
        judge: judgeDoneAtTwo,
        stopConditions: { aiJudgement: true, maxIterations: 5 },
      });
      const conversationId = await askForDrawing(p);

      await waitForEvent(p, conversationId, (e) => e.type === 'turn.ended' && e.turn === 2);
      await quiet();
      const events = await eventsOf(p, conversationId);
      const [jobId] = await p.jobs.listJobIds();
      expect(jobTurnsOf(events)).toEqual([
        expect.objectContaining({ turn: 2, jobId, messageSeqs: [] }),
      ]);
      // 回ごとには話しかけない: ジョブが回る間に始まったターンは、人間の発言を読んだ1つ目だけ
      const types = events.map((e) => e.type);
      expect(types.filter((t) => t === 'job.judge')).toHaveLength(2);
      expect(types.filter((t) => t === 'turn.started')).toHaveLength(2);
      const stoppedAt = types.indexOf('job.stopped');
      expect(events[stoppedAt]).toMatchObject({ reason: { kind: 'ai' } });
      expect(types.slice(stoppedAt)).toEqual([
        'job.stopped',
        'turn.started',
        'assistant.reasoning',
        'assistant.message',
        'turn.ended',
      ]);
      expect(events.at(-2)).toMatchObject({ type: 'assistant.message', text: REPORT });
      expect(events.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
      // 話す役の呼び出しは、描き始めるターンの 2 ステップと、話しかける 1 ステップだけ
      expect(p.llm.steps).toHaveLength(3);
      expect(textOf(p.llm.steps[2]!)).toContain('止まった（ai');
    });

    it('speaks once after the job reaches its iteration limit', async () => {
      const p = startProcess({
        judge: judgeNeverDone,
        stopConditions: { aiJudgement: false, maxIterations: 2 },
      });
      const conversationId = await askForDrawing(p);

      await waitForEvent(p, conversationId, (e) => e.type === 'turn.ended' && e.turn === 2);
      await quiet();
      const events = await eventsOf(p, conversationId);
      expect(events.find((e) => e.type === 'job.stopped')).toMatchObject({
        reason: { kind: 'limit:iterations' },
      });
      expect(jobTurnsOf(events)).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
    });

    it('speaks once after a stage of the job fails', async () => {
      const p = startProcess({
        judge: judgeBroken,
        stopConditions: { aiJudgement: true, maxIterations: 5 },
      });
      const conversationId = await askForDrawing(p);

      await waitForEvent(p, conversationId, (e) => e.type === 'turn.ended' && e.turn === 2);
      await quiet();
      const events = await eventsOf(p, conversationId);
      expect(events.find((e) => e.type === 'job.stopped')).toMatchObject({
        reason: { kind: 'error' },
      });
      expect(jobTurnsOf(events)).toHaveLength(1);
    });

    it('stays silent when a person stops the job', async () => {
      const p = startProcess({
        judge: judgeNeverDone,
        stopConditions: { aiJudgement: false, maxIterations: 10 },
      });
      const conversationId = await askForDrawing(p);
      await waitForEvent(p, conversationId, (e) => e.type === 'job.images');
      const [jobId] = await p.jobs.listJobIds();
      await p.jobRunner.stop(jobId!);

      await waitForEvent(p, conversationId, (e) => e.type === 'job.stopped');
      await quiet();
      const events = await eventsOf(p, conversationId);
      expect(events.find((e) => e.type === 'job.stopped')).toMatchObject({
        reason: { kind: 'human' },
      });
      expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1);
      expect(p.llm.steps.every((step) => step.tools.length > 0)).toBe(true);
    });

    it('stays silent when a person chooses an image and the job stops on it', async () => {
      const p = startProcess({
        judge: judgeNeverDone,
        stopConditions: { aiJudgement: false, maxIterations: 10 },
      });
      const conversationId = await askForDrawing(p);
      await waitForEvent(p, conversationId, (e) => e.type === 'job.images');
      const [jobId] = await p.jobs.listJobIds();
      await p.jobRunner.adopt(jobId!, { iteration: 1, index: 0 });

      await waitForEvent(p, conversationId, (e) => e.type === 'job.stopped');
      await quiet();
      const events = await eventsOf(p, conversationId);
      expect(events.find((e) => e.type === 'job.stopped')).toMatchObject({
        reason: { kind: 'adopted' },
      });
      expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1);
    });
  },
);

describe('after a restart', { timeout: TEST_TIMEOUT_MS }, () => {
  it('does not speak about a job that stopped just before the process went down', async () => {
    const before = startProcess({
      judge: judgeDoneAtTwo,
      stopConditions: { aiJudgement: true, maxIterations: 5 },
      wired: false,
    });
    const conversationId = await askForDrawing(before);
    await waitForEvent(before, conversationId, (e) => e.type === 'job.stopped');
    await waitForEvent(before, conversationId, (e) => e.type === 'turn.ended');

    const after = startProcess({
      judge: judgeDoneAtTwo,
      stopConditions: { aiJudgement: true, maxIterations: 5 },
    });
    await closeInterruptedTurns({ store: after.conversations, hubs: after.hubs });
    await backfillJobEvents({
      jobs: after.jobs,
      conversations: after.conversations,
      hubs: after.hubs,
    });
    after.jobRunner.kick();
    await quiet();
    const events = await eventsOf(after, conversationId);
    expect(jobTurnsOf(events)).toHaveLength(0);
    expect(after.llm.steps).toHaveLength(0);
  });

  it('does not speak when the restart fills in the stop that was not written to the conversation', async () => {
    const before = startProcess({
      judge: judgeNeverDone,
      stopConditions: { aiJudgement: false, maxIterations: 1 },
    });
    const { conversationId } = await before.conversations.createConversation(new Date());
    // 会話への写しを書く前に落ちたつもりで、ジョブは橋渡しを通さずに回す
    const spec = await before.jobs.createJob(
      {
        kind: 'auto',
        request: '夕暮れの海辺に立つ少女',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
        conversationId,
        turn: 1,
      },
      { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
      new Date(),
    );
    const unbridged = new JobRunner({
      store: new FsJobStore(root),
      llm: new ScriptedLlm({ think, judge: judgeNeverDone }),
      backend: new StubBackend(),
      budget: DEFAULT_BUDGET,
      permissions,
    });
    unbridged.kick();
    await vi.waitFor(
      async () => expect((await before.jobs.readState(spec.jobId)).status).toBe('stopped'),
      { timeout: TIMEOUT_MS },
    );
    expect((await eventsOf(before, conversationId)).map((e) => e.type)).toEqual(['job.started']);

    const after = startProcess({
      judge: judgeNeverDone,
      stopConditions: { aiJudgement: false, maxIterations: 1 },
    });
    await closeInterruptedTurns({ store: after.conversations, hubs: after.hubs });
    await backfillJobEvents({
      jobs: after.jobs,
      conversations: after.conversations,
      hubs: after.hubs,
    });
    await quiet();
    const events = await eventsOf(after, conversationId);
    expect(events.at(-1)).toMatchObject({ type: 'job.stopped' });
    expect(events.some((e) => e.type === 'turn.started')).toBe(false);
    expect(after.llm.steps).toHaveLength(0);
  });

  it('closes a speaking turn the restart cut off, and does not speak again', async () => {
    const before = startProcess({
      judge: judgeDoneAtTwo,
      stopConditions: { aiJudgement: true, maxIterations: 5 },
      // 話しかける途中で落ちたつもりで、返さない
      report: () => new Promise<void>(() => {}),
    });
    const conversationId = await askForDrawing(before);
    await waitForEvent(
      before,
      conversationId,
      (e) => e.type === 'turn.started' && 'jobId' in e && e.jobId !== undefined,
    );

    const after = startProcess({
      judge: judgeDoneAtTwo,
      stopConditions: { aiJudgement: true, maxIterations: 5 },
    });
    expect(await closeInterruptedTurns({ store: after.conversations, hubs: after.hubs })).toBe(1);
    await backfillJobEvents({
      jobs: after.jobs,
      conversations: after.conversations,
      hubs: after.hubs,
    });
    after.jobRunner.kick();
    await quiet();
    const events = await eventsOf(after, conversationId);
    expect(jobTurnsOf(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'turn.ended',
      turn: 2,
      outcome: 'interrupted',
      reason: RESTART_REASON,
    });
    expect(after.llm.steps).toHaveLength(0);
  });
});
