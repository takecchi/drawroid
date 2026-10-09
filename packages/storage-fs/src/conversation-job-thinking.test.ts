// 会話に属するジョブの、考える役・見る役の思考が、会話へ流れて確定し、次の入力には入らないことを見る試験（会話 J、#117）。
// LLM は台本どおりに返すスタブ（思考も台本で出す）、バックエンドは M1 のスタブ、置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  bridgeJobEvents,
  ConversationHubs,
  DEFAULT_BUDGET,
  JobRunner,
  relayJobReasoning,
  type HubMessage,
  type JobStore,
  type LlmCall,
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
  root = await mkdtemp(join(tmpdir(), 'drawroid-job-thinking-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '夕暮れの光を足す',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((p) => p.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: '逆光に',
  canStop: false,
});

async function setup() {
  const conversations = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store: conversations });
  const store: JobStore = bridgeJobEvents(new FsJobStore(root), { hubs });
  const llm = new ScriptedLlm(
    { think, judge },
    {
      reasoning: {
        think: (_call, n) => `考える思考${n}`,
        judge: (_call, n) => `見る思考${n}`,
      },
    },
  );
  const runner = new JobRunner({
    store,
    llm,
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 512, height: 512 }),
    onReasoning: relayJobReasoning({ store, hubs }),
  });
  const { conversationId } = await conversations.createConversation(new Date());
  return { conversations, hubs, store, llm, runner, conversationId };
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

const textOf = (call: LlmCall<unknown>) =>
  call.messages.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');

describe('the thinking of the jobs in a conversation', () => {
  it('flows to the conversation while the stage runs, then is confirmed on job.think and job.judge', async () => {
    const { hubs, store, runner, conversationId } = await setup();
    const received: HubMessage[] = [];
    await hubs.get(conversationId).subscribe(0, (message) => received.push(message));

    const { jobId } = await submit(store, conversationId);
    runner.kick();
    await runner.idle();

    const live = received.flatMap((m) =>
      m.kind === 'live' && m.event.type === 'delta.reasoning' ? [m.event] : [],
    );
    expect(live.map((e) => [e.source, e.text])).toEqual([
      [{ role: 'think', jobId, iteration: 1 }, '考える思考0'],
      [{ role: 'judge', jobId, iteration: 1 }, '見る思考0'],
      [{ role: 'think', jobId, iteration: 2 }, '考える思考1'],
      [{ role: 'judge', jobId, iteration: 2 }, '見る思考1'],
    ]);
    const confirmed = received.flatMap((m) => (m.kind === 'confirmed' ? [m.event] : []));
    expect(
      confirmed
        .filter((e) => e.type === 'job.think')
        .map((e) => e.type === 'job.think' && e.reasoning),
    ).toEqual(['考える思考0', '考える思考1']);
    expect(
      confirmed
        .filter((e) => e.type === 'job.judge')
        .map((e) => e.type === 'job.judge' && e.reasoning),
    ).toEqual(['見る思考0', '見る思考1']);
  });

  it('keeps no copy of the thinking once the stage is confirmed, so a late subscriber does not see it flowing', async () => {
    const { hubs, store, runner, conversationId } = await setup();
    await submit(store, conversationId);
    runner.kick();
    await runner.idle();

    const late: HubMessage[] = [];
    await hubs.get(conversationId).subscribe(0, (message) => late.push(message));
    expect(late.some((m) => m.kind === 'live')).toBe(false);
  });

  it('never puts the thinking into the next input of the thinking or the judging role', async () => {
    const { store, llm, runner, conversationId } = await setup();
    await submit(store, conversationId);
    runner.kick();
    await runner.idle();

    const later = llm.calls.filter((c) => !textOf(c).includes('これから 1 回目'));
    expect(later.length).toBeGreaterThan(0);
    for (const call of llm.calls) {
      expect(textOf(call)).not.toMatch(/考える思考|見る思考/);
    }
  });

  it('flows nothing for a job that belongs to no conversation', async () => {
    const { hubs, store, runner, conversationId } = await setup();
    const received: HubMessage[] = [];
    await hubs.get(conversationId).subscribe(0, (message) => received.push(message));
    await submit(store);
    runner.kick();
    await runner.idle();
    expect(received).toEqual([]);
  });
});
