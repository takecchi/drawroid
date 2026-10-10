import {
  buildThinkInput,
  createCarry,
  DEFAULT_BUDGET,
  DEFAULT_MODEL_WINDOW,
  LLM_CALL_FAILED_PREFIX,
  THINK_PARAM_KEYS,
  type LlmCallOutcome,
  type TalkStepPart,
} from '@drawroid/core';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AiSdkLlm } from './adapter.js';
import { llmConfigSchema, roleConfigSchema } from './config.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const config = roleConfigSchema.parse({ provider: 'local', model: 'qwen' });

function adapter(model: MockLanguageModelV4, callTimeoutSeconds?: number) {
  return new AiSdkLlm(
    { think: config, judge: config, talk: config },
    {
      think: { providerName: 'local', model },
      judge: { providerName: 'local', model },
      talk: { providerName: 'local', model },
    },
    {
      validationRetries: 0,
      networkRetries: 0,
      ...(callTimeoutSeconds === undefined ? {} : { callTimeoutSeconds }),
    },
  );
}

/**
 * 流れを開いたまま、渡した部品を流す。流れは閉じない（そのあと黙ったままの LLM）。
 * 中断されたら、中断の理由ではなく provider 自前の中断のエラーで流れを終える（fetch の実装によってはそうなるため）
 */
function silentAfter(parts: StreamPart[]): {
  model: MockLanguageModelV4;
  push: (part: StreamPart) => void;
} {
  let controller!: ReadableStreamDefaultController<StreamPart>;
  const stream = new ReadableStream<StreamPart>({
    start(c) {
      controller = c;
      for (const part of parts) c.enqueue(part);
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

const call = (signal = new AbortController().signal) => ({
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
  signal,
});

/**
 * 時計を進めずに、溜まった約束の続きだけを回す。vi.waitFor は使わない: 偽の時計を進めながら待つので、
 * 「ちょうど何秒で切れたか」を縛れなくなるため
 */
async function flush() {
  for (let i = 0; i < 50; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/** 約束が決着したかを、待たずに見る */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const START: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the time the LLM may stay silent', () => {
  it('is 300 seconds unless the settings say otherwise', () => {
    const parsed = llmConfigSchema.parse({
      providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1' } },
      roles: { think: { provider: 'local', model: 'qwen' } },
    });

    expect(parsed.callTimeoutSeconds).toBe(300);
  });

  it('gives up after exactly 300 seconds of silence by default, saying the LLM did not answer in time', async () => {
    const { model } = silentAfter([]);
    const outcome = track(adapter(model).generateStructured(call()));

    await vi.advanceTimersByTimeAsync(299_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(
      `${LLM_CALL_FAILED_PREFIX}LLM が時間内に答えなかった（300 秒、何も返らなかった）。LLM のサーバが動いているかを確かめる。遅いモデルなら、LLM の設定の「応答を待つ上限（秒）」を延ばす`,
    );
  });

  it('uses the time from the settings', async () => {
    const { model } = silentAfter([]);
    const outcome = track(adapter(model, 20).generateStructured(call()));

    await vi.advanceTimersByTimeAsync(19_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(outcome.settled).toBe(true);

    const result = outcome.value as LlmCallOutcome<unknown>;
    expect(!result.ok && result.reason).toContain('LLM が時間内に答えなかった（20 秒、');
  });

  // 遅いモデルでも、流れが続いている間は切らない: 測るのは黙っている時間で、呼び出しの全体の時間ではない
  it('does not give up while the answer keeps coming, however long it takes', async () => {
    const { model, push } = silentAfter(START);
    const outcome = track(adapter(model).generateStructured(call()));

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(299_000);
      push({ type: 'text-delta', id: 't', delta: i === 0 ? '{"prompt": "' : 'a' });
    }
    expect(outcome.settled).toBe(false);
    push({ type: 'text-delta', id: 't', delta: '"}' });
    push({ type: 'text-end', id: 't' });
    push({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    });
    await flush();
    expect(outcome.settled).toBe(true);

    expect((outcome.value as LlmCallOutcome<unknown>).ok).toBe(true);
  });

  // 思考だけ・ツール呼び出しの断片だけが流れていても、答えは来ている: 思考の長いモデルや、引数の長いツール呼び出しを切らない
  it.each([
    [
      'only the thinking',
      { type: 'reasoning-start', id: 'r' },
      (i: number): StreamPart => ({ type: 'reasoning-delta', id: 'r', delta: `考え${i}` }),
    ],
    [
      'only pieces of a tool call',
      { type: 'tool-input-start', id: 'c', toolName: 'search_candidates' },
      (i: number): StreamPart => ({ type: 'tool-input-delta', id: 'c', delta: `{"q${i}":` }),
    ],
  ] as [string, StreamPart, (i: number) => StreamPart][])(
    'does not give up while %s keeps coming',
    async (_, start, piece) => {
      const { model, push } = silentAfter([{ type: 'stream-start', warnings: [] }, start]);
      const controller = new AbortController();
      const outcome = track(adapter(model).generateStructured(call(controller.signal)));

      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(299_000);
        push(piece(i));
      }
      await flush();
      expect(outcome.settled).toBe(false);

      controller.abort();
      await flush();
    },
  );

  // 中身の無い部品は、答えが来たことにしない: 空の断片を送り続けるサーバで、いつまでも打ち切れなくならないように
  it.each([
    ['empty text', [{ type: 'text-delta', id: 't', delta: '' }]],
    [
      'empty thinking',
      [
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: '' },
      ],
    ],
    [
      'empty pieces of a tool call',
      [
        { type: 'tool-input-start', id: 'c', toolName: 'search_candidates' },
        { type: 'tool-input-delta', id: 'c', delta: '' },
      ],
    ],
    ['metadata only', [{ type: 'response-metadata', id: 'x', modelId: 'qwen' }]],
  ] as [string, StreamPart[]][])(
    'gives up after 300 seconds even when the server keeps sending %s',
    async (_, pieces) => {
      const { model, push } = silentAfter(START);
      const outcome = track(adapter(model).generateStructured(call()));

      await vi.advanceTimersByTimeAsync(200_000);
      for (const piece of pieces) push(piece);
      await vi.advanceTimersByTimeAsync(99_999);
      expect(outcome.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(outcome.settled).toBe(true);

      const result = outcome.value as LlmCallOutcome<unknown>;
      expect(!result.ok && result.reason).toContain('LLM が時間内に答えなかった（300 秒、');
    },
  );

  it('says the same for the talk role in a conversation', async () => {
    const { model } = silentAfter([]);
    const parts: TalkStepPart[] = [];
    const done = track(
      (async () => {
        for await (const part of adapter(model).streamStep({
          role: 'talk',
          messages: call().messages,
          tools: [],
          signal: new AbortController().signal,
        })) {
          parts.push(part);
        }
      })(),
    );

    await vi.advanceTimersByTimeAsync(300_000);
    await flush();
    expect(done.settled).toBe(true);

    const finish = parts.at(-1);
    expect(finish?.type === 'finish' && finish.failure).toContain(
      'LLM が時間内に答えなかった（300 秒、何も返らなかった）',
    );
  });

  // 人が止めたのは、時間切れではない（ジョブは人が止めたとして止まる）
  it('still throws when a person stops the call before the time runs out', async () => {
    const { model } = silentAfter([]);
    const controller = new AbortController();
    const outcome = track(adapter(model).generateStructured(call(controller.signal)));

    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await flush();
    expect(outcome.settled).toBe(true);

    expect(outcome.error).toBeDefined();
    expect(String(outcome.error)).not.toContain('何も返さなかった');
  });
});
