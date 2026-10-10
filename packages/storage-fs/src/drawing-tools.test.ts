// 話す役の描くツール（start_drawing・revise_drawing・stop_drawing）が、会話に属するジョブを作り・直し・止め、
// 許可を広げる引数と2つ目のジョブを断ることを見る試験（会話 F、#112）。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ、ジョブの置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  bridgeJobEvents,
  ConversationHubs,
  DEFAULT_BUDGET,
  createDrawingTools,
  DEFAULT_BUDGETS,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  mergePermissions,
  type DrawingToolDeps,
  type JobStore,
  type TalkTool,
  type TalkToolContext,
} from '@drawroid/core';
import {
  MemoryConversationStore,
  ScriptedLlm,
  STUB_PNG,
  StubBackend,
  type Script,
} from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-drawing-tools-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '案',
  intent: '夕暮れの海辺に立つ少女',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

const human = mergePermissions(basicPermissions({ width: 512, height: 512 }), {
  checkpoint: { mode: 'auto', choices: ['anime.safetensors'] },
});

async function setup() {
  const conversations = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store: conversations });
  const jobs: JobStore = bridgeJobEvents(new FsJobStore(root), { hubs });
  const runner = new JobRunner({
    store: jobs,
    llm: new ScriptedLlm({ think, judge }),
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions: human,
  });
  const { conversationId } = await conversations.createConversation(new Date());
  const tools = createDrawingTools({
    jobs,
    runner,
    conversations,
    humanPermissions: async () => human,
    candidateNames: async (kind) =>
      kind === 'checkpoint' ? ['anime.safetensors', 'real.safetensors'] : [],
    defaultStopConditions: async () => ({ aiJudgement: true, maxIterations: 3 }),
    budgets: async () => DEFAULT_BUDGETS,
    now: () => new Date('2026-10-09T06:30:12.000Z'),
  });
  // 会話の実行器が呼ぶたびに渡すもの（ターンの番号を含む）
  const talk: TalkToolContext = {
    conversationId,
    turn: 1,
    events: [],
    limits: DEFAULT_TALK_LIMITS,
    signal: new AbortController().signal,
  };
  const context: Context = { tools, talk };
  return { conversations, jobs, runner, context, conversationId };
}

/** 試験の間に回り終わらない止める条件: 止める・直すを、走っているジョブに確かめるため */
const LONG = { aiJudgement: false, maxIterations: 1000 };

type Context = { tools: TalkTool[]; talk: TalkToolContext };

const toolIn = (tools: readonly TalkTool[], name: string) => {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`ツール ${name} が無い`);
  return found;
};
// 説明だけを見るので、依存は空で作る
const described = createDrawingTools({} as DrawingToolDeps);
const startDrawing = toolIn(described, 'start_drawing');
const reviseDrawing = toolIn(described, 'revise_drawing');
const stopDrawing = toolIn(described, 'stop_drawing');

/** 引数はツールのスキーマで検証してから渡す（LLM のポートが検証済みの引数を返すのと同じ） */
const run = (name: string, input: unknown, context: Context) => {
  const found = toolIn(context.tools, name);
  return found.run(found.inputSchema.parse(input), context.talk);
};

/** ジョブが走り始めるまで待つ。止める・直す試験は、走っているジョブに対して確かめる */
async function untilRunning(jobs: JobStore, jobId: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while ((await jobs.readState(jobId)).status !== 'running') {
    if (Date.now() > deadline) throw new Error(`${jobId} が走り始めない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function jobIds(jobs: JobStore) {
  return jobs.listJobIds();
}

describe('start_drawing', () => {
  it('makes a job of the conversation and the turn, with the default stop conditions when none are given', async () => {
    const { jobs, runner, context, conversationId, conversations } = await setup();

    const outcome = await run('start_drawing', { request: '夕暮れの海辺に立つ少女' }, context);
    await runner.idle();

    expect(outcome).toMatchObject({ ok: true });
    const [jobId] = await jobIds(jobs);
    expect(await jobs.readJob(jobId!)).toMatchObject({
      kind: 'auto',
      request: '夕暮れの海辺に立つ少女',
      conversationId,
      turn: 1,
      stopConditions: { aiJudgement: true, maxIterations: 3 },
      batchSize: 1,
    });
    // 解決した止める条件は、ツールの結果に出る（人間がログで見て、言葉で直せるように）
    expect(outcome.summary).toContain(jobId!);
    expect(outcome.summary).toContain('AI の判断');
    expect(outcome.summary).toContain('3 回');
    const types = (await conversations.readEvents(conversationId)).events.map((e) => e.type);
    expect(types[0]).toBe('job.started');
    expect(types.at(-1)).toBe('job.stopped');
  });

  it('narrows the permissions of the job as asked, within what the human allowed', async () => {
    const { jobs, runner, context } = await setup();

    const outcome = await run(
      'start_drawing',
      {
        request: '海辺',
        permissions: { checkpoint: { mode: 'fixed', value: 'anime.safetensors' } },
      },
      context,
    );
    await runner.idle();

    expect(outcome.ok).toBe(true);
    const [jobId] = await jobIds(jobs);
    expect(await jobs.readJob(jobId!)).toMatchObject({
      permissions: { checkpoint: { mode: 'fixed', value: 'anime.safetensors' } },
    });
  });

  it.each([
    ['turning on what the human turned off', { vae: { mode: 'auto' } }, 'VAE'],
    [
      'fixing to a candidate the human did not choose',
      { checkpoint: { mode: 'fixed', value: 'real.safetensors' } },
      'checkpoint',
    ],
    ['changing what the human fixed', { width: { mode: 'fixed', value: 1024 } }, '幅'],
    ['handing back to the AI what the human fixed', { width: { mode: 'auto' } }, '幅'],
  ])('refuses %s, naming the parameter, and makes no job', async (_, permissions, label) => {
    const { jobs, runner, context, conversationId, conversations } = await setup();

    const outcome = await run('start_drawing', { request: '海辺', permissions }, context);
    await runner.idle();

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain(label);
    expect(await jobIds(jobs)).toEqual([]);
    const types = (await conversations.readEvents(conversationId)).events.map((e) => e.type);
    expect(types).not.toContain('job.started');
  });

  it('refuses a second drawing while the conversation already has one going, saying which', async () => {
    const { jobs, context, runner } = await setup();
    const first = await run('start_drawing', { request: '海辺', stopConditions: LONG }, context);
    expect(first.ok).toBe(true);
    const [running] = await jobIds(jobs);

    const second = await run('start_drawing', { request: '山' }, context);

    expect(second.ok).toBe(false);
    expect(second.summary).toContain(running!);
    expect(await jobIds(jobs)).toHaveLength(1);
    await untilRunning(jobs, running!);
    await runner.stop(running!);
    await runner.idle();
  });

  it('refuses more images at once than the judging role takes in one call, saying why, and makes no job', async () => {
    const { jobs, context } = await setup();

    const outcome = await run(
      'start_drawing',
      { request: '海辺', batchSize: DEFAULT_BUDGETS.imagesPerJudge + 1 },
      context,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain(`${DEFAULT_BUDGETS.imagesPerJudge} 枚`);
    expect(await jobIds(jobs)).toEqual([]);
  });

  it('draws as many images at once as the judging role takes in one call', async () => {
    const { jobs, runner, context } = await setup();

    const outcome = await run(
      'start_drawing',
      { request: '海辺', batchSize: DEFAULT_BUDGETS.imagesPerJudge },
      context,
    );
    await runner.idle();

    expect(outcome.ok).toBe(true);
    const [jobId] = await jobIds(jobs);
    expect(await jobs.readJob(jobId!)).toMatchObject({ batchSize: DEFAULT_BUDGETS.imagesPerJudge });
    const state = await jobs.readState(jobId!);
    expect(state.status === 'stopped' && state.reason.kind).not.toBe('error');
  });

  it('refuses stop conditions that would never stop', async () => {
    const { jobs, context } = await setup();

    const outcome = await run(
      'start_drawing',
      { request: '海辺', stopConditions: { aiJudgement: false } },
      context,
    );

    expect(outcome.ok).toBe(false);
    expect(await jobIds(jobs)).toEqual([]);
  });

  it('copies the images attached in the conversation to the references of the job', async () => {
    const { jobs, runner, context, conversations, conversationId } = await setup();
    const uploadId = await conversations.addUpload(
      conversationId,
      { data: STUB_PNG, mediaType: 'image/png' },
      new Date(),
    );

    const outcome = await run(
      'start_drawing',
      { request: '海辺', attachments: [{ uploadId, note: 'この構図で' }] },
      context,
    );
    const [started] = await jobIds(jobs);
    await untilRunning(jobs, started!);
    await runner.stop(started!);
    await runner.idle();

    expect(outcome.ok).toBe(true);
    const [jobId] = await jobIds(jobs);
    expect(await jobs.listReferences(jobId!)).toEqual([
      expect.objectContaining({ mediaType: 'image/png', note: 'この構図で' }),
    ]);
  });

  it('refuses an attachment that is not in the conversation', async () => {
    const { jobs, context } = await setup();

    const outcome = await run(
      'start_drawing',
      { request: '海辺', attachments: [{ uploadId: '20261009-000000-none' }] },
      context,
    );

    expect(outcome.ok).toBe(false);
    expect(await jobIds(jobs)).toEqual([]);
  });
});

describe('revise_drawing and stop_drawing', () => {
  it('puts an instruction and a change of stop conditions on the drawing going on', async () => {
    const { jobs, context, runner } = await setup();
    await run('start_drawing', { request: '海辺', stopConditions: LONG }, context);
    const [jobId] = await jobIds(jobs);

    const revised = await run(
      'revise_drawing',
      { instruction: '逆光にして', stopConditions: { maxIterations: 5 } },
      context,
    );

    expect(revised.ok).toBe(true);
    const interventions = await jobs.listInterventions(jobId!);
    expect(interventions.map((i) => i.kind).sort()).toEqual(['instruction', 'stopConditions']);
    await untilRunning(jobs, jobId!);
    await runner.stop(jobId!);
    await runner.idle();
  });

  it('adds the images attached in the conversation to the references of the drawing going on', async () => {
    const { jobs, context, runner, conversations, conversationId } = await setup();
    await run('start_drawing', { request: '海辺', stopConditions: LONG }, context);
    const [jobId] = await jobIds(jobs);
    const uploadId = await conversations.addUpload(
      conversationId,
      { data: STUB_PNG, mediaType: 'image/png' },
      new Date(),
    );

    const revised = await run(
      'revise_drawing',
      { attachments: [{ uploadId, note: 'この色で' }] },
      context,
    );

    expect(revised).toMatchObject({ ok: true });
    expect(revised.summary).toContain('参照画像を 1 枚添えた');
    // 口出しの記録の形は増やさない: 走っているジョブの参照画像（refs/）として置く
    expect(await jobs.listReferences(jobId!)).toEqual([
      expect.objectContaining({ mediaType: 'image/png', note: 'この色で' }),
    ]);
    expect(await jobs.listInterventions(jobId!)).toEqual([]);
    await untilRunning(jobs, jobId!);
    await runner.stop(jobId!);
    await runner.idle();
  });

  it('changes nothing when one of the attached images is not in the conversation', async () => {
    const { jobs, context, runner, conversations, conversationId } = await setup();
    await run('start_drawing', { request: '海辺', stopConditions: LONG }, context);
    const [jobId] = await jobIds(jobs);
    const uploadId = await conversations.addUpload(
      conversationId,
      { data: STUB_PNG, mediaType: 'image/png' },
      new Date(),
    );

    const revised = await run(
      'revise_drawing',
      {
        instruction: '逆光にして',
        attachments: [{ uploadId }, { uploadId: '20261009-000000-none' }],
      },
      context,
    );

    expect(revised.ok).toBe(false);
    expect(revised.summary).toContain('20261009-000000-none');
    expect(await jobs.listReferences(jobId!)).toEqual([]);
    expect(await jobs.listInterventions(jobId!)).toEqual([]);
    await untilRunning(jobs, jobId!);
    await runner.stop(jobId!);
    await runner.idle();
  });

  it('stops the drawing going on', async () => {
    const { jobs, context, runner } = await setup();
    await run('start_drawing', { request: '海辺', stopConditions: LONG }, context);
    const [jobId] = await jobIds(jobs);
    await untilRunning(jobs, jobId!);

    const stopped = await run('stop_drawing', {}, context);
    await runner.idle();

    expect(stopped.ok).toBe(true);
    expect(await jobs.readState(jobId!)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'human' },
    });
  });

  it('says there is nothing to revise or stop when the conversation has no drawing going on', async () => {
    const { context } = await setup();

    expect(await run('revise_drawing', { instruction: '逆光にして' }, context)).toMatchObject({
      ok: false,
    });
    expect(await run('stop_drawing', {}, context)).toMatchObject({ ok: false });
  });

  it('describes when to call each tool in its definition, not in a system prompt', () => {
    expect(startDrawing.description).toContain('描くよう求めたときだけ');
    expect(startDrawing.description).toContain('呼ばない');
    expect(reviseDrawing.description).not.toBe('');
    expect(stopDrawing.description).not.toBe('');
  });
});
