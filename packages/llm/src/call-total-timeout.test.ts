import {
  buildThinkInput,
  createCarry,
  DEFAULT_BUDGET,
  DEFAULT_MODEL_WINDOW,
  LLM_CALL_FAILED_PREFIX,
  THINK_PARAM_KEYS,
  toLlmCallRecord,
  type LlmCallOutcome,
  type TalkStepPart,
} from '@drawroid/core';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AiSdkLlm } from './adapter.js';
import { roleConfigSchema } from './config.js';
import { createLlm } from './index.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const config = roleConfigSchema.parse({ provider: 'local', model: 'qwen' });

function adapter(
  model: MockLanguageModelV4,
  options: { totalCallTimeoutSeconds?: number; callTimeoutSeconds?: number; retries?: number } = {},
) {
  return new AiSdkLlm(
    { think: config, judge: config, talk: config },
    {
      think: { providerName: 'local', model },
      judge: { providerName: 'local', model },
      talk: { providerName: 'local', model },
    },
    {
      validationRetries: options.retries ?? 0,
      networkRetries: 0,
      ...(options.totalCallTimeoutSeconds === undefined
        ? {}
        : { totalCallTimeoutSeconds: options.totalCallTimeoutSeconds }),
      ...(options.callTimeoutSeconds === undefined
        ? {}
        : { callTimeoutSeconds: options.callTimeoutSeconds }),
    },
  );
}

/** 流れを開いたまま部品を流せる偽の LLM。中断されたら、provider 自前の中断のエラーで流れを終える */
function openStream(): { model: MockLanguageModelV4; push: (part: StreamPart) => void } {
  let controller!: ReadableStreamDefaultController<StreamPart>;
  const stream = new ReadableStream<StreamPart>({
    start(c) {
      controller = c;
      c.enqueue({ type: 'stream-start', warnings: [] });
      c.enqueue({ type: 'text-start', id: 't' });
    },
  });
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      abortSignal?.addEventListener('abort', () =>
        controller.error(new DOMException('This operation was aborted', 'AbortError')),
      );
      return { stream };
    },
  });
  return {
    model,
    push: (part) => {
      controller.enqueue(part);
      if (part.type === 'finish') controller.close();
    },
  };
}

/** 呼び出しのたびに新しい流れを開く偽の LLM。push は、いちばん新しく開いた流れへ流す */
function openStreamPerAttempt(): { model: MockLanguageModelV4; push: (part: StreamPart) => void } {
  let controller!: ReadableStreamDefaultController<StreamPart>;
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      let own!: ReadableStreamDefaultController<StreamPart>;
      const stream = new ReadableStream<StreamPart>({
        start(c) {
          own = c;
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: 't' });
        },
      });
      controller = own;
      abortSignal?.addEventListener('abort', () =>
        own.error(new DOMException('This operation was aborted', 'AbortError')),
      );
      return { stream };
    },
  });
  return {
    model,
    push: (part) => {
      controller.enqueue(part);
      if (part.type === 'finish') controller.close();
    },
  };
}

const call = () => ({
  role: 'think' as const,
  purpose: 'think' as const,
  schema: z.object({ prompt: z.string() }),
  messages: buildThinkInput({
    carry: createCarry('夕暮れの海辺の少女', DEFAULT_BUDGET).carry,
    progress: { iteration: 1 },
    allowed: THINK_PARAM_KEYS,
    budget: DEFAULT_BUDGET,
    window: DEFAULT_MODEL_WINDOW,
  }),
  signal: new AbortController().signal,
});

async function flush() {
  for (let i = 0; i < 50; i += 1) await vi.advanceTimersByTimeAsync(0);
}

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const chunk = (): StreamPart => ({ type: 'text-delta', id: 't', delta: 'あ' });

/** 10 秒ごとに増分を返し続ける（止まらない LLM）。時計を seconds まで進める（seconds 丁度には増分を送らない） */
async function runawayUntil(push: (part: StreamPart) => void, seconds: number) {
  // 答えの JSON の文字列の中を出し続ける: 構造化出力は、JSON として読み進められる増分だけを流れとして返すため
  push({ type: 'text-delta', id: 't', delta: '{"prompt": "' });
  for (let elapsed = 10; elapsed <= seconds; elapsed += 10) {
    await vi.advanceTimersByTimeAsync(10_000);
    if (elapsed < seconds) push(chunk());
  }
}

const finishPart = (): StreamPart => ({
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the time one LLM call may take in total', () => {
  it('gives up after exactly 900 seconds by default even though the answer never stops coming', async () => {
    const { model, push } = openStream();
    const outcome = track(adapter(model).generateStructured(call()));

    await runawayUntil(push, 890);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(
      `${LLM_CALL_FAILED_PREFIX}LLM が時間内に終わらなかった（1回の呼び出しの全体の上限 900 秒を超えた。出力は流れ続けていた）。出力が止まらないモデルかもしれない。LLM の設定の「1回の呼び出しの全体の上限（秒）」（config.json の llm.totalCallTimeoutSeconds）を延ばすか、役の出力の上限（maxOutputTokens）を設ける`,
    );
  });

  it('uses the time from the settings', async () => {
    const { model, push } = openStream();
    const outcome = track(
      adapter(model, { totalCallTimeoutSeconds: 60 }).generateStructured(call()),
    );

    await runawayUntil(push, 50);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(!result.ok && result.reason).toContain('全体の上限 60 秒を超えた');
  });

  it('lets a call that keeps streaming finish when it ends before the time is up', async () => {
    const { model, push } = openStream();
    const outcome = track(adapter(model).generateStructured(call()));

    await runawayUntil(push, 800);
    push({ type: 'text-delta', id: 't', delta: '"}' });
    push({ type: 'text-end', id: 't' });
    push(finishPart());
    await flush();
    expect(outcome.settled).toBe(true);

    expect((outcome.value as LlmCallOutcome<unknown>).ok).toBe(true);
  });

  it('is not retried like a wrong answer: the call is asked once and the run stops with the reason', async () => {
    const { model, push } = openStream();
    const outcome = track(
      adapter(model, { totalCallTimeoutSeconds: 30, retries: 2 }).generateStructured(call()),
    );

    await runawayUntil(push, 30);
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(!result.ok && result.attempts).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('starts the total time again for each asking again after a wrong answer', async () => {
    const { model, push } = openStreamPerAttempt();
    const outcome = track(
      adapter(model, { totalCallTimeoutSeconds: 30, retries: 1 }).generateStructured(call()),
    );

    // 1回目: 全体の上限の少し手前（25 秒）まで流してから、閉じない JSON のまま終える（スキーマに合わない出力）
    await flush();
    await runawayUntil(push, 20);
    await vi.advanceTimersByTimeAsync(5_000);
    push({ type: 'text-end', id: 't' });
    push(finishPart());
    await flush();
    expect(outcome.settled).toBe(false);
    expect(model.doStreamCalls).toHaveLength(2);

    // 2回目: 通しでは 50 秒目まで流れるが、1回の試行としては 25 秒で、正しい出力で終わる
    await runawayUntil(push, 20);
    await vi.advanceTimersByTimeAsync(5_000);
    push({ type: 'text-delta', id: 't', delta: '"}' });
    push({ type: 'text-end', id: 't' });
    push(finishPart());
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(2);
  });

  it('leaves no timer behind once a call has finished', async () => {
    const before = vi.getTimerCount();
    const { model, push } = openStream();
    const outcome = track(adapter(model).generateStructured(call()));

    push({ type: 'text-delta', id: 't', delta: '{"prompt": "x"}' });
    push({ type: 'text-end', id: 't' });
    push(finishPart());
    await flush();
    expect(outcome.settled).toBe(true);
    expect((outcome.value as LlmCallOutcome<unknown>).ok).toBe(true);

    expect(vi.getTimerCount()).toBe(before);
  });

  it('leaves a failed record in the LLM call log, with the total limit as the reason and the time spent', async () => {
    const { model, push } = openStream();
    const started = vi.fn();
    started.mockReturnValueOnce(0).mockReturnValue(30_000);
    const llm = new AiSdkLlm(
      { think: config, judge: config, talk: config },
      {
        think: { providerName: 'local', model },
        judge: { providerName: 'local', model },
        talk: { providerName: 'local', model },
      },
      { validationRetries: 0, networkRetries: 0, totalCallTimeoutSeconds: 30, now: started },
    );
    const request = call();
    const outcome = track(llm.generateStructured(request));

    await runawayUntil(push, 30);
    await flush();

    const record = toLlmCallRecord({
      callId: 'c1',
      jobId: 'j1',
      iteration: 1,
      role: 'think',
      purpose: 'think',
      provider: 'local',
      model: 'qwen',
      startedAt: new Date(0),
      messages: request.messages,
      outcome: outcome.value as LlmCallOutcome<unknown>,
    });
    expect(record.outcome.ok).toBe(false);
    expect(!record.outcome.ok && record.outcome.reason).toContain('全体の上限 30 秒を超えた');
    expect(record.attempts).toHaveLength(1);
    expect(record.durationMs).toBe(30_000);
  });

  it('says the same for the talk role in a conversation', async () => {
    const { model, push } = openStream();
    const parts: TalkStepPart[] = [];
    const done = track(
      (async () => {
        for await (const part of adapter(model, { totalCallTimeoutSeconds: 30 }).streamStep({
          role: 'talk',
          messages: call().messages,
          tools: [],
          signal: new AbortController().signal,
        })) {
          parts.push(part);
        }
      })(),
    );

    await runawayUntil(push, 30);
    await flush();
    expect(done.settled).toBe(true);

    const finish = parts.at(-1);
    expect(finish?.type === 'finish' && finish.failure).toContain('全体の上限 30 秒を超えた');
  });

  it('still says nothing came back when the LLM goes silent before the total time', async () => {
    const { model } = openStream();
    const outcome = track(
      adapter(model, { callTimeoutSeconds: 20, totalCallTimeoutSeconds: 900 }).generateStructured(
        call(),
      ),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(!result.ok && result.reason).toContain(
      'LLM が時間内に答えなかった（20 秒、何も返らなかった）',
    );
  });

  // 10 秒ごとに増分を返し続ける、本物の HTTP の流れに近い偽のサーバ
  const runawayServer = async (_input: string | URL | Request, init?: RequestInit) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let first = true;
        const tick = (): void => {
          const content = first ? '{"prompt": "' : 'あ';
          first = false;
          const data = { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          timer = setTimeout(tick, 10_000);
        };
        let timer: ReturnType<typeof setTimeout>;
        tick();
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const llmFromSettings = (settings: object) =>
    createLlm(
      {
        providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1' } },
        roles: { think: { provider: 'local', model: 'qwen' } },
        networkRetries: 0,
        ...settings,
      },
      { env: {}, fetch: runawayServer as typeof globalThis.fetch },
    );

  it('applies the limit written in the LLM settings to a call made from those settings', async () => {
    const outcome = track(
      llmFromSettings({ totalCallTimeoutSeconds: 30 }).generateStructured(call()),
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(!result.ok && result.reason).toContain('全体の上限 30 秒を超えた');
  });

  it('applies 900 seconds to a call made from settings that do not write the limit', async () => {
    const outcome = track(llmFromSettings({}).generateStructured(call()));

    await vi.advanceTimersByTimeAsync(899_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(!result.ok && result.reason).toContain('全体の上限 900 秒を超えた');
  });
});
