// ジョブ実行器（JobRunner）の段のファイルが、会話に属するジョブのときだけ、会話のイベント（job.*）として
// 確定することを見る試験（会話 F、#112）。LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ、置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  bridgeJobEvents,
  ConversationHubs,
  DEFAULT_BUDGET,
  JobRunner,
  mergePermissions,
  type AdoptedRecord,
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
  root = await mkdtemp(join(tmpdir(), 'drawroid-conversation-bridge-'));
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
  // 口出しを取り込む回だけ、統合した要点が要る。ほかの回では出力スキーマに無く、捨てられる
  intent: '夕暮れの海辺に立つ少女、逆光',
});
const judge: Script = (call, n) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.4 + n * 0.1, issues: ['手が崩れている'] })),
  nextChange: '手を隠す構図に',
  canStop: false,
});

async function setup() {
  const conversations = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store: conversations });
  const errors: unknown[] = [];
  const store: JobStore = bridgeJobEvents(new FsJobStore(root), {
    hubs,
    onError: (error) => errors.push(error),
  });
  const runner = new JobRunner({
    store,
    llm: new ScriptedLlm({ think, judge }),
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    // inpaint を任せてもマスクが無いので、その回の選択肢から外れて plan.json に載る
    permissions: mergePermissions(basicPermissions({ width: 512, height: 512 }), {
      inpaint: { mode: 'auto' },
    }),
  });
  const { conversationId } = await conversations.createConversation(new Date());
  return { conversations, hubs, store, runner, conversationId, errors };
}

async function submit(store: JobStore, conversationId?: string) {
  return store.createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: false, maxIterations: 2 },
      batchSize: 1,
      ...(conversationId !== undefined && { conversationId, turn: 1 }),
    },
    { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
    new Date(),
  );
}

const adopted: AdoptedRecord = {
  by: 'human',
  image: { iteration: 1, index: 0 },
  score: 1,
  interventionId: 'int-1',
  adoptedAt: '2026-10-09T15:30:00+09:00',
};

const typesOf = (events: ConversationEvent[]) => events.map((e) => e.type);

describe('the bridge from a job to its conversation', () => {
  it('confirms the stages of a job that belongs to a conversation, in the order they happened', async () => {
    const { conversations, store, runner, conversationId, errors } = await setup();

    const spec = await submit(store, conversationId);
    runner.kick();
    await runner.idle();

    const { events } = await conversations.readEvents(conversationId);
    expect(typesOf(events)).toEqual([
      'job.started',
      'job.think',
      'job.images',
      'job.judge',
      'job.think',
      'job.images',
      'job.judge',
      'job.stopped',
    ]);
    expect(events.every((e) => !('jobId' in e) || e.jobId === spec.jobId)).toBe(true);
    expect(events[0]).toMatchObject({
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: false, maxIterations: 2 },
    });
    expect(events[1]).toMatchObject({
      iteration: 1,
      rationale: '夕暮れの光を足す',
      params: { prompt: 'girl, beach, sunset', cfgScale: 6 },
    });
    // 頼んだ大きさも載せる: 画面が、読み込む前から画像の背を取るため
    expect(events[2]).toMatchObject({
      iteration: 1,
      images: [{ index: 0 }],
      size: { width: 512, height: 512 },
    });
    expect(events[3]).toMatchObject({
      iteration: 1,
      images: [{ index: 0, score: 0.4, issues: ['手が崩れている'] }],
      nextChange: '手を隠す構図に',
      canStop: false,
    });
    expect(events.at(-1)).toMatchObject({ reason: { kind: 'limit:iterations' } });
    expect(errors).toEqual([]);
  });

  it('puts on job.think what the plan left out of the AI choices that iteration', async () => {
    const { conversations, store, runner, conversationId } = await setup();

    await submit(store, conversationId);
    runner.kick();
    await runner.idle();

    const firstThink = (await conversations.readEvents(conversationId)).events.find(
      (e) => e.type === 'job.think',
    );
    expect(firstThink).toMatchObject({
      excluded: [{ param: 'inpaint', wanted: 'auto', reason: { kind: 'no-mask' } }],
    });
  });

  it('confirms an instruction taken in at the iteration it was taken in', async () => {
    const { conversations, store, runner, conversationId } = await setup();

    const spec = await submit(store, conversationId);
    await runner.addInstruction(spec.jobId, '逆光にして');
    runner.kick();
    await runner.idle();

    const taken = (await conversations.readEvents(conversationId)).events.find(
      (e) => e.type === 'job.intervention',
    );
    expect(taken).toMatchObject({ jobId: spec.jobId, kind: 'instruction', iteration: 1 });
  });

  it('confirms job.adopted, not job.judge, for an iteration a human settled by choosing an image', async () => {
    const { conversations, store, conversationId, errors } = await setup();
    const spec = await submit(store, conversationId);

    await store.writeAdopted(spec.jobId, 1, adopted);

    expect(typesOf((await conversations.readEvents(conversationId)).events)).toEqual([
      'job.started',
      'job.adopted',
    ]);
    expect((await conversations.readEvents(conversationId)).events[1]).toMatchObject({
      jobId: spec.jobId,
      iteration: 1,
      image: { iteration: 1, index: 0 },
    });
    expect(errors).toEqual([]);
  });

  it('confirms nothing when a job that belongs to no conversation has an image chosen', async () => {
    const { conversations, store, conversationId } = await setup();
    const spec = await submit(store);

    await store.writeAdopted(spec.jobId, 1, adopted);

    expect((await conversations.readEvents(conversationId)).events).toEqual([]);
  });

  it('confirms nothing for a job that belongs to no conversation', async () => {
    const { conversations, store, runner, conversationId } = await setup();

    await submit(store);
    runner.kick();
    await runner.idle();

    expect((await conversations.readEvents(conversationId)).events).toEqual([]);
  });

  it('lets the job go on when its events cannot be written, and says why', async () => {
    const { store, runner, hubs, conversationId, errors } = await setup();
    const hub = hubs.get(conversationId);
    hub.confirm = () => Promise.reject(new Error('会話の置き場所に書けない'));

    const spec = await submit(store, conversationId);
    runner.kick();
    await runner.idle();

    expect(await store.readState(spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'limit:iterations' },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
