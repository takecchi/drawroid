// drawroid の組み立て（assembleDrawroid）を、本物のファイルの置き場所で起動して見る試験。
// 組み立ての順（話す役を立ててからジョブを再開する・落ちる前の止まりで話しかけ直さない）と、止める合図のつなぎは、
// 部品の試験からは見えないため、組み立てそのものを呼ぶ
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FsConversationStore,
  FsJobStore,
  initDataDir,
  writeLlmSettings,
} from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assembleDrawroid, type AssembledDrawroid } from './assemble.js';

/** 話しかけないことを見るときに、何も起きないのを待つ長さ */
const QUIET_MS = 500;

let root: string;
let webRoot: string;
let running: AssembledDrawroid | undefined;

beforeEach(async () => {
  const work = await mkdtemp(join(tmpdir(), 'drawroid-assemble-'));
  root = join(work, 'data');
  webRoot = join(work, 'web');
  await mkdir(webRoot);
  await initDataDir(root);
});
afterEach(async () => {
  // 後ろの仕事が走り終えるのを待ってから消す: 待ち受けを閉じても、ジョブと話す役のターンは書き続けるため
  await running?.idle();
  await new Promise((resolve) => (running ? running.server.close(resolve) : resolve(undefined)));
  running = undefined;
  // 繰り返す: 組み立ては止める口を持たず、止まったジョブの蒸留などが片付けの最中にも書き込んで、rmdir が ENOTEMPTY で落ちることがあるため
  await rm(join(root, '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function start(signals = new EventEmitter(), exit = vi.fn()) {
  return assembleDrawroid({
    root,
    // 繋がらないバックエンド: この試験では生成しない
    args: { port: 0, backend: undefined, backendUrl: 'http://127.0.0.1:9' },
    env: {},
    signals,
    exit,
    write: () => undefined,
    webRoot,
  }).then((listening) => (running = listening));
}

/** 会話に属する、AI の判断で止まったジョブ（落ちる前に止まった）を置く */
async function stoppedJobOf(conversationId: string) {
  const spec = await new FsJobStore(root).createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: true, maxIterations: 5 },
      batchSize: 1,
      conversationId,
      turn: 1,
    },
    {
      status: 'stopped',
      carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 1 },
      stoppedAt: new Date().toISOString(),
      imagesGenerated: 1,
      reason: { kind: 'ai', detail: '見る役が意図どおりと判断した' },
    },
    new Date(),
  );
  return spec.jobId;
}

const turnsStarted = async (conversations: FsConversationStore, conversationId: string) =>
  (await conversations.readEvents(conversationId)).events.filter((e) => e.type === 'turn.started');

describe('assembleDrawroid after a restart', () => {
  // 落ちる前の止まりで話しかけ直さない: 途切れたターンをやり直さないのと同じく、話しかけるのは止まったその場だけ
  it('does not speak about a job that stopped before the process went down, even if it had not spoken yet', async () => {
    const conversations = new FsConversationStore(root);
    const { conversationId } = await conversations.createConversation(new Date());
    const jobId = await stoppedJobOf(conversationId);
    const now = new Date();
    await conversations.appendEvent(
      conversationId,
      {
        type: 'job.started',
        jobId,
        request: '夕暮れの海辺に立つ少女',
        stopConditions: { aiJudgement: true, maxIterations: 5 },
      },
      now,
    );
    await conversations.appendEvent(
      conversationId,
      {
        type: 'job.stopped',
        jobId,
        reason: { kind: 'ai', detail: '見る役が意図どおりと判断した' },
      },
      now,
    );

    await start();
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    expect(await turnsStarted(conversations, conversationId)).toEqual([]);
  });

  it('does not speak when the restart fills in the stop that was not written to the conversation', async () => {
    const conversations = new FsConversationStore(root);
    const { conversationId } = await conversations.createConversation(new Date());
    const jobId = await stoppedJobOf(conversationId);
    await conversations.appendEvent(
      conversationId,
      {
        type: 'job.started',
        jobId,
        request: '夕暮れの海辺に立つ少女',
        stopConditions: { aiJudgement: true, maxIterations: 5 },
      },
      new Date(),
    );

    await start();
    await vi.waitFor(async () =>
      expect((await conversations.readEvents(conversationId)).events.at(-1)).toMatchObject({
        type: 'job.stopped',
        jobId,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    expect(await turnsStarted(conversations, conversationId)).toEqual([]);
  });

  // 再開したジョブの止まりは、話す役へ届いて話しかける（話す役を立ててからジョブを再開するため）
  it('speaks about a job resumed after a restart once it stops', async () => {
    const role = {
      provider: 'local',
      model: 'm',
      structuredOutput: 'native',
      reasoning: 'native',
      toolCalling: 'native',
      imageInput: true,
    };
    // 繋がらない LLM: 再開したジョブは考える段で失敗して、すぐ error で止まる
    await writeLlmSettings(join(root, 'config.json'), {
      providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1' } },
      roles: { think: role },
      validationRetries: 0,
      networkRetries: 0,
    });
    const conversations = new FsConversationStore(root);
    const { conversationId } = await conversations.createConversation(new Date());
    const spec = await new FsJobStore(root).createJob(
      {
        kind: 'auto',
        request: '夕暮れの海辺に立つ少女',
        stopConditions: { aiJudgement: true, maxIterations: 5 },
        batchSize: 1,
        conversationId,
        turn: 1,
      },
      { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
      new Date(),
    );

    await start();

    await vi.waitFor(
      async () =>
        expect(await turnsStarted(conversations, conversationId)).toEqual([
          expect.objectContaining({ jobId: spec.jobId }),
        ]),
      { timeout: 5_000 },
    );
    // ターンが閉じるまで待つ: 閉じる前に片付けると、ターンの書き込みと片付けが重なるため
    await vi.waitFor(
      async () =>
        expect((await conversations.readEvents(conversationId)).events).toContainEqual(
          expect.objectContaining({ type: 'turn.ended' }),
        ),
      { timeout: 5_000 },
    );
  });
});

describe('assembleDrawroid and the signals to stop', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('ends with the code of %s when it is told to stop', async (signal, code) => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    await start(signals, exit);

    signals.emit(signal);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code));
  });
});
