// review_image を、本物のファイルのジョブの置き場所と本物のループに通して見る試験。
// 評価済みの画像は呼ばず、評価の無い画像は見る役を1回だけ呼び、その評価を段の出力（judge.json）には書かず、
// LLM 呼び出しの記録から2回目に返すこと。LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  bridgeJobEvents,
  ConversationHubs,
  createDrawingTools,
  createReviewTools,
  DEFAULT_BUDGET,
  DEFAULT_BUDGETS,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  mergePermissions,
  type JobStore,
  type TalkTool,
  type TalkToolContext,
} from '@drawroid/core';
import {
  MemoryConversationStore,
  ScriptedLlm,
  StubBackend,
  type Script,
} from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';
import { dataPaths } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-review-tools-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '案',
  intent: '夕暮れの海辺に立つ少女',
});
// 2 回目の見る役だけ落ちる: 評価の前に止まった回を作る
const judge: Script = (call, n) => {
  if (n === 1) throw new Error('見る役が落ちた');
  return {
    images: call.messages.user
      .filter((part) => part.type === 'image')
      .map(() => ({ score: 0.5, issues: ['空が暗い'] })),
    nextChange: '空を明るく',
    canStop: false,
  };
};

const human = mergePermissions(basicPermissions({ width: 512, height: 512 }), {
  checkpoint: { mode: 'auto', choices: ['anime.safetensors'] },
});

async function setup() {
  const conversations = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store: conversations });
  const jobs: JobStore = bridgeJobEvents(new FsJobStore(root), { hubs });
  const llm = new ScriptedLlm({ think, judge });
  const runner = new JobRunner({
    store: jobs,
    llm,
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions: human,
  });
  const { conversationId } = await conversations.createConversation(new Date());
  const context: TalkToolContext = {
    conversationId,
    turn: 1,
    events: [],
    limits: DEFAULT_TALK_LIMITS,
    signal: new AbortController().signal,
  };
  const drawing = createDrawingTools({
    jobs,
    runner,
    conversations,
    humanPermissions: async () => human,
    candidateNames: async () => ['anime.safetensors'],
    defaultStopConditions: async () => ({ aiJudgement: false, maxIterations: 2 }),
    budgets: async () => DEFAULT_BUDGETS,
    now: () => new Date(),
  });
  const [review] = createReviewTools({
    jobs,
    llm: () => llm,
    budgets: async () => DEFAULT_BUDGETS,
  }) as [TalkTool];
  const call = (tool: TalkTool, input: unknown) => tool.run(tool.inputSchema.parse(input), context);
  const draw = async () => {
    const start = drawing.find((tool) => tool.name === 'start_drawing')!;
    await call(start, { request: '夕暮れの海辺に立つ少女' });
    await runner.idle();
    const [jobId] = await jobs.listJobIds();
    return jobId!;
  };
  return { jobs, llm, review, call, draw };
}

describe('review_image over the files of a job', () => {
  it('returns the evaluation the loop wrote for the image, without calling the judge again', async () => {
    const { llm, review, call, draw } = await setup();
    await draw();
    const judgeCalls = llm.calls.filter((c) => c.purpose === 'judge').length;

    const result = await call(review, { iteration: 1 });

    expect(result).toMatchObject({ ok: true });
    expect(result.result).toContain('1枚目は 0.50（空が暗い）');
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(judgeCalls);
  });

  it('judges an image the loop never evaluated once, keeps the call in the records, and answers the second ask from them', async () => {
    const { jobs, llm, review, call, draw } = await setup();
    const jobId = await draw();
    const files = dataPaths(root).jobFiles(jobId);
    expect(await jobs.readStage(jobId, 2, 'judge')).toBeUndefined();
    const judgeCalls = llm.calls.filter((c) => c.purpose === 'judge').length;

    const first = await call(review, { iteration: 2 });
    const second = await call(review, { iteration: 2 });

    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    const added = llm.calls.filter((c) => c.purpose === 'judge').slice(judgeCalls);
    expect(added).toHaveLength(1);
    expect(added[0]!.messages.user.filter((part) => part.type === 'image')).toHaveLength(1);
    const { records } = await jobs.listLlmCallRecords(jobId);
    const reviewed = records.filter((r) => r.iteration === 2 && r.purpose === 'judge');
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.usage.inputTokens).not.toBeNull();
    // ループの段の出力は書かない: ループ・再開・止める判定が、この評価で変わらない
    await expect(readFile(files.iteration(2).judge)).rejects.toThrow();
  });
});
