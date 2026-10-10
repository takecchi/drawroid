// LLM 呼び出しの記録（jobs/<id>/llm-calls/・conversations/<id>/llm-calls/）に、モデルの思考が載ることを見る通しの試験。
// docs/design/conversational-agent.md の「思考は記録に載せる（デバッグのため）」の約束。
// LLM は台本どおりに返すスタブ（思考も台本で出す）、置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  ConversationHubs,
  DEFAULT_BUDGET,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  TalkRunner,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsConversationStore } from './conversation-store.js';
import { FsJobStore } from './job-store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-llm-call-reasoning-'));
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

describe('the LLM call records of a job', () => {
  it('carry the thinking of the thinking and the judging role, and chars do not count it', async () => {
    const store = new FsJobStore(root);
    const llm = new ScriptedLlm(
      { think, judge },
      { reasoning: { think: (_c, n) => `考える思考${n}`, judge: (_c, n) => `見る思考${n}` } },
    );
    const runner = new JobRunner({
      store,
      llm,
      backend: new StubBackend(),
      budget: DEFAULT_BUDGET,
      permissions: basicPermissions({ width: 512, height: 512 }),
    });
    const { jobId } = await store.createJob(
      {
        kind: 'auto',
        request: '夕暮れの海辺に立つ少女',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
      },
      { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
      new Date(),
    );
    runner.kick();
    await runner.idle();

    const { records } = await store.listLlmCallRecords(jobId);
    const thinkRecord = records.find((r) => r.purpose === 'think');
    const judgeRecord = records.find((r) => r.purpose === 'judge');
    expect(thinkRecord?.attempts).toEqual([expect.objectContaining({ reasoning: '考える思考0' })]);
    expect(judgeRecord?.attempts).toEqual([expect.objectContaining({ reasoning: '見る思考0' })]);
    // 文字数は生の出力だけを数える。思考は数えない
    const rawOutput = (thinkRecord?.attempts[0] as { rawOutput: string }).rawOutput;
    expect(thinkRecord?.chars?.output).toBe(rawOutput.length);
    expect(rawOutput).not.toContain('考える思考');
  });
});

describe('the LLM call records of a conversation', () => {
  it('carry the thinking of the talking role, and chars do not count it', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const llm = new ScriptedLlm(
      {},
      { talk: () => ({ reasoning: '話す思考', text: '描けます。' }) },
    );
    const runner = new TalkRunner({
      store: conversations,
      hubs,
      llm: () => llm,
      tools: [],
      limits: async () => DEFAULT_TALK_LIMITS,
    });
    const { conversationId } = await conversations.createConversation(new Date());
    await hubs
      .get(conversationId)
      .confirm({ type: 'user.message', text: '描けますか？', attachments: [] });
    runner.kick(conversationId);
    await runner.idle(conversationId);

    const { records } = await conversations.listLlmCallRecords(conversationId);
    expect(records).toHaveLength(1);
    expect(records[0]?.attempts).toEqual([expect.objectContaining({ reasoning: '話す思考' })]);
    const rawOutput = (records[0]?.attempts[0] as { rawOutput: string }).rawOutput;
    // 台本の rawOutput は台本の1ステップの全部を書き出すので、ここでは「rawOutput の長さだけ」を見る
    expect(records[0]?.chars?.output).toBe(rawOutput.length);
  });
});
