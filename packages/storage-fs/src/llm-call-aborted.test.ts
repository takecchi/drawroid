// 打ち切られた LLM 呼び出し（人の停止・会話の割り込み）が、出力を途中まで流していても、
// 記録（jobs/<id>/llm-calls/・conversations/<id>/llm-calls/）に入力・途中までの出力・打ち切った理由が残ることを見る通しの試験。
// LLM は、増分を少し流してから、呼び手の中断を待って止まるスタブ。置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  ConversationHubs,
  DEFAULT_BUDGET,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  LlmCallAborted,
  TalkRunner,
  type LlmCall,
  type LlmCallOutcome,
  type LlmPurpose,
  type TalkStepCall,
  type TalkStepPart,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsConversationStore } from './conversation-store.js';
import { FsJobStore } from './job-store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-llm-call-aborted-'));
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
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

type Written = { text: string; reasoning: string };

/** 指定した用途の呼び出しで、本文と思考を少し流したところで、呼び手が止めるまで返らない LLM */
class StreamsThenHangs extends ScriptedLlm {
  private readonly entered = new Map<LlmPurpose, () => void>();
  private readonly enteredPromises = new Map<LlmPurpose, Promise<void>>();

  constructor(
    private readonly hangs: Hangs,
    private readonly talkHang?: Written,
  ) {
    super({ think, judge }, { talk: () => ({ text: 'はい' }) });
  }

  /** その用途の呼び出しが、流し終えて止まるまで待つ */
  reached(purpose: LlmPurpose): Promise<void> {
    return this.enteredPromise(purpose);
  }

  private enteredPromise(purpose: LlmPurpose): Promise<void> {
    let promise = this.enteredPromises.get(purpose);
    if (promise === undefined) {
      promise = new Promise<void>((resolve) => this.entered.set(purpose, resolve));
      this.enteredPromises.set(purpose, promise);
    }
    return promise;
  }

  override async generateStructured<T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>> {
    const hang = this.hangs[call.purpose];
    if (hang === undefined) return super.generateStructured(call);
    call.onReasoning?.(hang.reasoning);
    void this.enteredPromise(call.purpose);
    this.entered.get(call.purpose)?.();
    await new Promise<void>((resolve) =>
      call.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw new LlmCallAborted(
      [
        {
          rawOutput: hang.text,
          usage: { inputTokens: null, outputTokens: null },
          durationMs: 5,
          reasoning: hang.reasoning,
        },
      ],
      new Error('呼び手が止めた'),
    );
  }

  override async *streamStep(call: TalkStepCall): AsyncIterable<TalkStepPart> {
    const hang = this.talkHang;
    if (hang === undefined) {
      yield* super.streamStep(call);
      return;
    }
    yield { type: 'reasoning-delta', text: hang.reasoning };
    yield { type: 'text-delta', text: hang.text };
    void this.enteredPromise('talk');
    this.entered.get('talk')?.();
    await new Promise<never>((_, reject) =>
      call.signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('呼び手が止めた'), { name: 'AbortError' })),
        { once: true },
      ),
    );
  }
}
type Hangs = { [purpose in LlmPurpose]?: Written };

async function createAutoJob(store: FsJobStore) {
  return store.createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: false, maxIterations: 3 },
      batchSize: 1,
    },
    { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
    new Date(),
  );
}

describe('stopping a job while the thinking or the judging role is still writing', () => {
  it.each(['think', 'judge'] as const)(
    'leaves a record of the %s call with its input, what it had written so far, and that a person stopped it',
    async (purpose) => {
      const store = new FsJobStore(root);
      const llm = new StreamsThenHangs({
        [purpose]: {
          text: '{"params": {"prompt": "girl, be',
          reasoning: '夕焼けにするか考えている',
        },
      });
      const runner = new JobRunner({
        store,
        llm,
        backend: new StubBackend(),
        budget: DEFAULT_BUDGET,
        permissions: basicPermissions({ width: 64, height: 64 }),
      });
      const { jobId } = await createAutoJob(store);
      runner.kick();
      await llm.reached(purpose);

      await runner.stop(jobId);
      await runner.idle();

      expect(await store.readState(jobId)).toMatchObject({
        status: 'stopped',
        reason: { kind: 'human' },
      });
      const { records } = await store.listLlmCallRecords(jobId);
      const aborted = records.filter((r) => r.purpose === purpose);
      expect(aborted).toHaveLength(1);
      const record = aborted[0]!;
      expect(record.outcome.ok).toBe(false);
      // 時間切れ・スキーマ違い・ネットワークの失敗とは別の言い方で、呼び手が打ち切ったと言う
      const reason = record.outcome.ok ? '' : record.outcome.reason;
      expect(reason).toContain('呼び手が打ち切った');
      expect(reason).not.toContain('時間内に答えなかった');
      expect(reason).not.toContain('スキーマに合わなかった');
      expect(record.input.system).not.toBe('');
      expect(record.input.user.length).toBeGreaterThan(0);
      expect(record.attempts).toEqual([
        expect.objectContaining({
          rawOutput: '{"params": {"prompt": "girl, be',
          reasoning: '夕焼けにするか考えている',
        }),
      ]);
      expect(record.chars?.output).toBe('{"params": {"prompt": "girl, be'.length);
    },
  );
});

describe('interrupting the turn of the talking role while it is still writing', () => {
  it('leaves a record of the call with its input, what it had written so far, and that a person interrupted it', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const llm = new StreamsThenHangs(
      {},
      { text: '少し考えます、まず', reasoning: '依頼を読んでいる' },
    );
    const talk = new TalkRunner({
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
    talk.kick(conversationId);
    await llm.reached('talk');

    await talk.interrupt(conversationId, 'turn');
    await talk.idle(conversationId);

    const events = (await conversations.readEvents(conversationId)).events;
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'interrupted' });
    const { records } = await conversations.listLlmCallRecords(conversationId);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.outcome).toEqual({ ok: false, reason: '人間の割り込みで打ち切った' });
    expect(record.input.system).not.toBe('');
    expect(record.attempts).toEqual([
      expect.objectContaining({ rawOutput: '少し考えます、まず', reasoning: '依頼を読んでいる' }),
    ]);
    expect(record.chars?.output).toBe('少し考えます、まず'.length);
  });
});

/** LLM 呼び出しの記録だけを書けない置き場所 */
function refusingRecords<S extends object>(inner: S): S {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'writeLlmCall') {
        return async () => {
          throw new Error('ディスクが満杯');
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe('when the record of a cut-off call cannot be written', () => {
  it('still closes the turn as interrupted', async () => {
    const files = new FsConversationStore(root);
    const conversations = refusingRecords(files);
    const hubs = new ConversationHubs({ store: conversations });
    const llm = new StreamsThenHangs(
      {},
      { text: '少し考えます、まず', reasoning: '依頼を読んでいる' },
    );
    const talk = new TalkRunner({
      store: conversations,
      hubs,
      llm: () => llm,
      tools: [],
      limits: async () => DEFAULT_TALK_LIMITS,
    });
    const { conversationId } = await files.createConversation(new Date());
    await hubs
      .get(conversationId)
      .confirm({ type: 'user.message', text: '描けますか？', attachments: [] });
    talk.kick(conversationId);
    await llm.reached('talk');

    await talk.interrupt(conversationId, 'turn');
    await talk.idle(conversationId);

    const events = (await files.readEvents(conversationId)).events;
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'interrupted' });
  });

  it('still stops the job as stopped by the human', async () => {
    const files = new FsJobStore(root);
    const store = refusingRecords(files);
    const llm = new StreamsThenHangs({ think: { text: '{"par', reasoning: '考え中' } });
    const runner = new JobRunner({
      store,
      llm,
      backend: new StubBackend(),
      budget: DEFAULT_BUDGET,
      permissions: basicPermissions({ width: 64, height: 64 }),
    });
    const { jobId } = await createAutoJob(files);
    runner.kick();
    await llm.reached('think');

    await runner.stop(jobId);
    await vi.waitFor(async () =>
      expect(await files.readState(jobId)).toMatchObject({
        status: 'stopped',
        reason: { kind: 'human' },
      }),
    );
    await runner.idle();
  });
});
