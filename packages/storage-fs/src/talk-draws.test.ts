// 会話で「○○を描いて」と言うと、話す役が start_drawing を呼び、会話に属するジョブが回って、ジョブの各段が
// 会話のイベントとして順に確定することを、会話の実行器（TalkRunner）から通しで見る試験（会話 F、#112）。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ、ジョブの置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  bridgeJobEvents,
  ConversationHubs,
  createDrawingTools,
  DEFAULT_BUDGET,
  DEFAULT_BUDGETS,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  jobSummaryFor,
  TalkRunner,
  type ConversationEvent,
  type JobStore,
} from '@drawroid/core';
import {
  MemoryConversationStore,
  ScriptedLlm,
  StubBackend,
  type Script,
} from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-talk-draws-'));
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
  rationale: '夕暮れの光を足す',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.6, issues: [] })),
  nextChange: '空をもう少し赤く',
  canStop: false,
});

describe('a conversation that asks for a drawing', () => {
  it('starts a job of the conversation through start_drawing, and confirms its stages in order', async () => {
    const conversations = new MemoryConversationStore();
    const hubs = new ConversationHubs({ store: conversations });
    const jobs: JobStore = bridgeJobEvents(new FsJobStore(root), { hubs });
    const permissions = basicPermissions({ width: 64, height: 64 });
    // 話す役: 1ステップ目で描き始め、2ステップ目で返答する
    const llm = new ScriptedLlm(
      { think, judge },
      {
        talk: (_call, n) =>
          n === 0
            ? {
                text: '描きます。',
                toolCalls: [
                  {
                    name: 'start_drawing',
                    input: {
                      request: '夕暮れの海辺に立つ少女',
                      stopConditions: { aiJudgement: false, maxIterations: 2 },
                    },
                  },
                ],
              }
            : { text: '描き始めました。' },
      },
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
    const { conversationId } = await conversations.createConversation(new Date());

    await hubs
      .get(conversationId)
      .confirm({ type: 'user.message', text: '夕暮れの海辺の少女を描いて' });
    talk.kick(conversationId);
    await talk.idle(conversationId);
    await jobRunner.idle();

    const { events } = await conversations.readEvents(conversationId);
    const types = events.map((e) => e.type);
    // ターンの流れ: 発言 → ターン → 描くツール → 返答
    expect(types.slice(0, 2)).toEqual(['user.message', 'turn.started']);
    const call = events.find((e) => e.type === 'tool.call');
    expect(call).toMatchObject({ name: 'start_drawing', turn: 1 });
    const result = events.find(
      (e): e is Extract<ConversationEvent, { type: 'tool.result' }> => e.type === 'tool.result',
    );
    expect(result).toMatchObject({ ok: true });
    expect(result!.summary).toContain('2 回まで');
    expect(types).toContain('turn.ended');
    // ジョブの流れ: 会話 ID とターン付きのジョブが、止まるまで順に確定する
    expect(types.filter((t) => t.startsWith('job.'))).toEqual([
      'job.started',
      'job.think',
      'job.images',
      'job.judge',
      'job.think',
      'job.images',
      'job.judge',
      'job.stopped',
    ]);
    expect(types.indexOf('tool.call')).toBeLessThan(types.indexOf('job.started'));
    const [jobId] = await jobs.listJobIds();
    expect(await jobs.readJob(jobId!)).toMatchObject({ conversationId, turn: 1 });
  });
});
