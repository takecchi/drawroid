// 会話のジョブが止まったら、話す役から1度だけ話しかけることを、会話の実行器（TalkRunner）の口から見る試験。
// ジョブの実行器は立てず、橋渡しが確定するのと同じ形の job.started / job.stopped を会話に置いてから知らせる
import { describe, expect, it, vi } from 'vitest';

import type { JobStore } from '../../job/store.js';
import type { StopReason } from '../../job/types.js';
import { basicPermissions } from '../../loop/iteration-permissions.js';
import { MemoryConversationStore } from '../../testing/memory-conversation-store.js';
import { ScriptedLlm, type TalkScript } from '../../testing/scripted-llm.js';
import { StubBackend } from '../../testing/stub-backend.js';
import type { ConversationEvent } from '../events.js';
import { ConversationHubs } from '../hub.js';
import { DEFAULT_TALK_LIMITS } from './limits.js';
import { TalkRunner } from './runner.js';
import { createReadOnlyTools } from './tools.js';

/** 話しかけるターンが確定するまで待つ上限 */
const TURN_TIMEOUT_MS = 2_000;
/** 話しかけないことを見るときに、何も起きないのを待つ長さ */
const QUIET_MS = 300;

const now = () => new Date('2026-10-10T03:00:00.000Z');
const JOB = '20261010-030000-ab12';
const noJobs = {
  readState: () => Promise.reject(new Error('この試験では使わない')),
} as unknown as JobStore;

const AI_STOP: StopReason = { kind: 'ai', detail: '見る役が意図どおりと判断した' };
const HUMAN_STOP: StopReason = { kind: 'human', detail: '人間が止めた' };

// 本物のモデル（think-tag の思考を切り出すもの）は、思考のあとの本文を改行で始めて返す
const reportStep = {
  reasoning: 'ジョブが止まったので、最良の画像と点数を伝える。',
  text: '\n\n描き終わりました。最良は 2 回目の 1枚目で 0.92 です。',
};

async function setup(talk: TalkScript) {
  const store = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store, now });
  const { conversationId } = await store.createConversation(now());
  const llm = new ScriptedLlm({}, { talk });
  const backend = new StubBackend();
  const runner = new TalkRunner({
    store,
    hubs,
    llm: () => llm,
    tools: createReadOnlyTools({
      backend,
      permissions: async () => basicPermissions({ width: 1024, height: 1024 }),
      jobs: noJobs,
    }),
    limits: async () => DEFAULT_TALK_LIMITS,
    jobSummary: async (events) =>
      events.some((e) => e.type === 'job.stopped')
        ? `ジョブ ${JOB} は止まった（ai: 見る役が意図どおりと判断した）。2 回済み。最良は 2 回目の 1枚目で 0.92（問題なし）。`
        : `ジョブ ${JOB} は走っている。`,
    now,
  });
  const hub = hubs.get(conversationId);
  const events = async () => (await store.readEvents(conversationId)).events;
  const jobTurns = async () =>
    (await events()).filter(
      (e): e is Extract<ConversationEvent, { type: 'turn.started' }> =>
        e.type === 'turn.started' && 'jobId' in e && e.jobId !== undefined,
    );
  const startJob = (jobId = JOB) =>
    hub.confirm({
      type: 'job.started',
      jobId,
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: true, maxIterations: 5 },
    });
  /** 橋渡しと同じく、job.stopped を確定してから知らせる */
  const stopJob = async (reason: StopReason, jobId = JOB) => {
    await hub.confirm({ type: 'job.stopped', jobId, reason });
    runner.reportJobStopped({ conversationId, jobId, reason });
  };
  const say = async (text: string) => {
    await hub.confirm({ type: 'user.message', text, attachments: [] });
    runner.kick(conversationId);
  };
  const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  const turnEnded = (turn: number) =>
    vi.waitFor(
      async () => {
        expect((await events()).some((e) => e.type === 'turn.ended' && e.turn === turn)).toBe(true);
      },
      { timeout: TURN_TIMEOUT_MS },
    );
  return {
    store,
    hub,
    llm,
    runner,
    conversationId,
    events,
    jobTurns,
    startJob,
    stopJob,
    say,
    quiet,
    turnEnded,
  };
}

describe('TalkRunner after a job of the conversation stops', () => {
  it.each<[string, StopReason]>([
    ['the judge said it is done', AI_STOP],
    ['it reached the iteration limit', { kind: 'limit:iterations', detail: '5 回に達した' }],
    ['it reached the image limit', { kind: 'limit:images', detail: '8 枚に達した' }],
    ['it reached the time limit', { kind: 'limit:duration', detail: '600 秒に達した' }],
    ['a stage failed', { kind: 'error', detail: '見る段: 形が合わない' }],
  ])('speaks once, unprompted, when %s', async (_, reason) => {
    const { startJob, stopJob, events, jobTurns, turnEnded, quiet } = await setup(() => reportStep);
    await startJob();
    await stopJob(reason);

    await turnEnded(1);
    await quiet();
    const all = await events();
    expect(await jobTurns()).toEqual([
      expect.objectContaining({ type: 'turn.started', turn: 1, jobId: JOB, messageSeqs: [] }),
    ]);
    const stoppedAt = all.findIndex((e) => e.type === 'job.stopped');
    expect(all.slice(stoppedAt).map((e) => e.type)).toEqual([
      'job.stopped',
      'turn.started',
      'assistant.reasoning',
      'assistant.message',
      'turn.ended',
    ]);
    expect(all.at(-2)).toMatchObject({
      type: 'assistant.message',
      text: '描き終わりました。最良は 2 回目の 1枚目で 0.92 です。',
    });
    expect(all.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
  });

  it.each<[string, StopReason]>([
    ['a person stopped it', HUMAN_STOP],
    ['a person chose an image', { kind: 'adopted', detail: '人間が画像を選んだ' }],
  ])('stays silent when %s', async (_, reason) => {
    const { startJob, stopJob, events, llm, quiet } = await setup(() => reportStep);
    await startJob();
    await stopJob(reason);

    await quiet();
    expect((await events()).map((e) => e.type)).toEqual(['job.started', 'job.stopped']);
    expect(llm.steps).toHaveLength(0);
  });

  it('answers from the job and the stop alone: no tools, one step, the stop in the input', async () => {
    const { startJob, stopJob, llm, turnEnded } = await setup(() => reportStep);
    await startJob();
    await stopJob(AI_STOP);

    await turnEnded(1);
    expect(llm.steps).toHaveLength(1);
    expect(llm.steps[0]!.tools).toEqual([]);
    const input = llm.steps[0]!.messages.user.map((part) =>
      part.type === 'text' ? part.text : '',
    ).join('\n');
    expect(input).toContain('止まった');
    expect(input).toContain('0.92');
  });

  it('puts the job-stopped line in the input of a report-only turn, and not in a turn for a person', async () => {
    const LINE = '会話のジョブが止まった。その結果を、人間に短く伝える。';
    const inputOf = (step: { messages: { user: { type: string; text?: string }[] } }) =>
      step.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    const report = await setup(() => reportStep);
    await report.startJob();
    await report.stopJob(AI_STOP);
    await report.turnEnded(1);
    expect(inputOf(report.llm.steps[0]!)).toContain(LINE);

    const human = await setup(() => ({ text: 'はい。' }));
    await human.startJob();
    await human.say('いまどんな感じ？');
    await human.turnEnded(1);
    expect(human.llm.steps).toHaveLength(1);
    expect(inputOf(human.llm.steps[0]!)).not.toContain(LINE);
  });

  describe('when many events follow the stop', () => {
    // 発言と返事が 50 件を超えて続いても（遡りの1ページを超えても）、job.stopped まで遡る
    const fill = async (hub: { confirm: (e: never) => Promise<unknown> }, count: number) => {
      for (let i = 0; i < count; i += 1) {
        await hub.confirm({
          type: 'assistant.message',
          turn: 1,
          partId: `p${i}`,
          text: `返事 ${i}`,
          interrupted: false,
        } as never);
      }
    };

    it('still speaks when more than 50 events follow the stop', async () => {
      const { startJob, hub, runner, conversationId, jobTurns, turnEnded } = await setup(
        () => reportStep,
      );
      await startJob();
      await hub.confirm({ type: 'job.stopped', jobId: JOB, reason: AI_STOP });
      await fill(hub, 120);
      runner.reportJobStopped({ conversationId, jobId: JOB, reason: AI_STOP });

      await turnEnded(1);
      expect(await jobTurns()).toHaveLength(1);
    });

    it('stays silent when a different job started more than 50 events back', async () => {
      const { startJob, hub, runner, conversationId, events, llm, quiet } = await setup(
        () => reportStep,
      );
      await startJob();
      await hub.confirm({ type: 'job.stopped', jobId: JOB, reason: AI_STOP });
      await startJob('20261010-030500-cd34');
      await fill(hub, 120);
      runner.reportJobStopped({ conversationId, jobId: JOB, reason: AI_STOP });

      await quiet();
      expect((await events()).some((e) => e.type === 'turn.started')).toBe(false);
      expect(llm.steps).toHaveLength(0);
    });
  });

  it('speaks only once when the same stop is reported twice before the turn starts', async () => {
    const { startJob, stopJob, runner, conversationId, jobTurns, turnEnded, quiet } = await setup(
      () => reportStep,
    );
    await startJob();
    await stopJob(AI_STOP);
    runner.reportJobStopped({ conversationId, jobId: JOB, reason: AI_STOP });

    await turnEnded(1);
    await quiet();
    expect(await jobTurns()).toHaveLength(1);
  });

  it('does not speak while the job has not stopped in the conversation yet', async () => {
    const { startJob, runner, conversationId, events, llm, quiet } = await setup(() => reportStep);
    await startJob();
    // 回の途中（job.stopped がまだ無い）に知らされても、話しかけない
    runner.reportJobStopped({ conversationId, jobId: JOB, reason: AI_STOP });

    await quiet();
    expect((await events()).map((e) => e.type)).toEqual(['job.started']);
    expect(llm.steps).toHaveLength(0);
  });

  it('does not speak again for a job it already spoke about', async () => {
    const { startJob, stopJob, runner, conversationId, jobTurns, turnEnded, quiet, llm } =
      await setup(() => reportStep);
    await startJob();
    await stopJob(AI_STOP);
    await turnEnded(1);

    runner.reportJobStopped({ conversationId, jobId: JOB, reason: AI_STOP });
    await quiet();
    expect(await jobTurns()).toHaveLength(1);
    expect(llm.steps).toHaveLength(1);
  });

  it('does not speak about a job that a newer job of the conversation replaced', async () => {
    const { startJob, hub, runner, conversationId, events, quiet } = await setup(() => reportStep);
    const reason: StopReason = { kind: 'error', detail: '生成の段: 繋がらない' };
    await startJob();
    await hub.confirm({ type: 'job.stopped', jobId: JOB, reason });
    // 止まりを話す前に、走っていたターンが次のジョブを描き始めた
    await startJob('20261010-030500-cd34');
    runner.reportJobStopped({ conversationId, jobId: JOB, reason });

    await quiet();
    expect((await events()).some((e) => e.type === 'turn.started')).toBe(false);
  });

  it('lets a running turn finish first, then speaks', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { startJob, stopJob, say, events, jobTurns, turnEnded, quiet } = await setup(
      async (call) => {
        if (call.tools.length > 0) {
          await gate;
          return { text: '描いている途中です。' };
        }
        return reportStep;
      },
    );
    await startJob();
    await say('いまどんな感じ？');
    await vi.waitFor(
      async () => expect((await events()).some((e) => e.type === 'turn.started')).toBe(true),
      { timeout: TURN_TIMEOUT_MS },
    );
    await stopJob(AI_STOP);

    await quiet();
    // 走っているターンは打ち切らない
    expect(await jobTurns()).toHaveLength(0);
    expect((await events()).some((e) => e.type === 'turn.ended')).toBe(false);
    release();
    await turnEnded(2);
    const all = await events();
    expect(all.find((e) => e.type === 'turn.ended' && e.turn === 1)).toMatchObject({
      outcome: 'done',
    });
    expect(await jobTurns()).toEqual([
      expect.objectContaining({ turn: 2, jobId: JOB, messageSeqs: [] }),
    ]);
  });

  it('answers the person and reports the stop in one turn when both are waiting', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { startJob, stopJob, say, events, jobTurns, turnEnded, quiet, llm } = await setup(
      async (_call, n) => {
        if (n === 0) {
          await gate;
          return { text: '描いている途中です。' };
        }
        return { text: '描き終わりました。次は空を赤くしますか？' };
      },
    );
    await startJob();
    await say('いまどんな感じ？');
    await vi.waitFor(
      async () => expect((await events()).some((e) => e.type === 'turn.started')).toBe(true),
      { timeout: TURN_TIMEOUT_MS },
    );
    await stopJob(AI_STOP);
    // 2つ目の発言は、走っているターンを打ち切る
    await say('空はもっと赤くできる？');
    release();

    await turnEnded(2);
    await quiet();
    const second = (await events()).find((e) => e.type === 'user.message' && e.text.includes('空'));
    expect(await jobTurns()).toEqual([
      expect.objectContaining({ turn: 2, jobId: JOB, messageSeqs: [second!.seq] }),
    ]);
    // 人間に答えるターンなので、ツールは渡す
    expect(llm.steps.at(-1)!.tools.length).toBeGreaterThan(0);
    expect((await events()).filter((e) => e.type === 'turn.started')).toHaveLength(2);
  });
});
