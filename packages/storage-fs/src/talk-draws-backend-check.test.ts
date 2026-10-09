// 描き始める前に、画像のバックエンドに繋がるかを確かめることを見る試験。繋がらなければジョブを作らず、何が足りないかを
// 道具の結果として話す役に返す。繋がるときは問い合わせ1回だけで、そのまま描き始める。ジョブの置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BackendError,
  basicPermissions,
  bridgeJobEvents,
  ConversationHubs,
  createDrawingTools,
  DEFAULT_BUDGET,
  DEFAULT_BUDGETS,
  DEFAULT_TALK_LIMITS,
  JobRunner,
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
  root = await mkdtemp(join(tmpdir(), 'drawroid-talk-draws-check-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '案',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.6, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

async function askToDraw(checkBackend?: (signal: AbortSignal) => Promise<void>) {
  const conversations = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store: conversations });
  const files = new FsJobStore(root);
  const jobs: JobStore = bridgeJobEvents(files, { hubs });
  const permissions = basicPermissions({ width: 64, height: 64 });
  const llm = new ScriptedLlm(
    { think, judge },
    {
      talk: (_call, n) =>
        n === 0
          ? {
              toolCalls: [
                {
                  name: 'start_drawing',
                  input: {
                    request: '夕暮れの海辺に立つ少女',
                    stopConditions: { aiJudgement: false, maxIterations: 1 },
                  },
                },
              ],
            }
          : { text: '返します' },
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
      ...(checkBackend !== undefined && { checkBackend }),
    }),
    limits: async () => DEFAULT_TALK_LIMITS,
  });
  const { conversationId } = await conversations.createConversation(new Date());
  await hubs.get(conversationId).confirm({ type: 'user.message', text: '海辺の少女を描いて' });
  talk.kick(conversationId);
  await talk.idle(conversationId);
  await jobRunner.idle();
  const { events } = await conversations.readEvents(conversationId);
  const result = events.find(
    (e): e is Extract<ConversationEvent, { type: 'tool.result' }> => e.type === 'tool.result',
  );
  return { events, result, jobIds: await files.listJobIds(), llm };
}

describe('checking the backend before starting to draw', () => {
  it('starts no job when the backend cannot be reached, and tells the talking role what is missing', async () => {
    const { events, result, jobIds, llm } = await askToDraw(async () => {
      throw new BackendError(
        'unreachable',
        'http://127.0.0.1:7860/ に繋がらない（ECONNREFUSED）。Forge が起動しているか、URL とポートが合っているかを確かめる',
      );
    });

    expect(jobIds).toEqual([]);
    expect(events.some((e) => e.type === 'job.started')).toBe(false);
    expect(result).toMatchObject({ ok: false });
    expect(result!.summary).toContain('描き始められない');
    expect(result!.summary).toContain('バックエンド');
    expect(result!.summary).toContain('ECONNREFUSED');
    // 話す役の次のステップの入力に、何が足りないかが載る（人に伝えられる）
    const next = llm.steps[1]!.messages.user.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(next).toContain('Forge が起動しているか');
  });

  it('says how long it waited when the backend does not answer', async () => {
    const { result, jobIds } = await askToDraw(async (signal) => {
      // 応答の無いバックエンド: 待ちの上限で切られる
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () =>
          reject(new BackendError('aborted', '呼び手が止めた')),
        ),
      );
    });

    expect(jobIds).toEqual([]);
    expect(result!.summary).toMatch(/\d+ 秒待っても応答が無い/);
  }, 10_000);

  it('asks the backend once and starts the job when it can be reached', async () => {
    let asked = 0;
    const { result, jobIds } = await askToDraw(async () => {
      asked += 1;
    });

    expect(asked).toBe(1);
    expect(result).toMatchObject({ ok: true });
    expect(jobIds).toHaveLength(1);
  });

  it('starts the job without asking when no check is wired', async () => {
    const { result, jobIds } = await askToDraw();

    expect(result).toMatchObject({ ok: true });
    expect(jobIds).toHaveLength(1);
  });
});
