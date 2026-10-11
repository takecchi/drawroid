// 呼び出しが途中で終わったとき（人の中断・時間切れ）に、それまでに流れた本文と思考が、試行として返ることを見る試験。
// 記録（llm-calls）に残すのは、この試行である。モデルは AI SDK のモック（流れを開いたまま黙る）
import {
  buildThinkInput,
  createCarry,
  DEFAULT_BUDGET,
  DEFAULT_MODEL_WINDOW,
  LlmCallAborted,
  THINK_PARAM_KEYS,
  type LlmCallOutcome,
  type TalkStepPart,
} from '@drawroid/core';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AiSdkLlm } from './adapter.js';
import { roleConfigSchema } from './config.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const config = roleConfigSchema.parse({ provider: 'local', model: 'qwen' });

function adapter(model: MockLanguageModelV4, validationRetries = 0) {
  return new AiSdkLlm(
    { think: config, judge: config, talk: config },
    {
      think: { providerName: 'local', model },
      judge: { providerName: 'local', model },
      talk: { providerName: 'local', model },
    },
    { validationRetries, networkRetries: 0 },
  );
}

/** 渡した部品を流したあと、流れを開いたまま黙る。中断されたら、provider 自前の中断のエラーで流れを終える */
function streamsThenSilent(parts: StreamPart[]): MockLanguageModelV4 {
  let controller!: ReadableStreamDefaultController<StreamPart>;
  const stream = new ReadableStream<StreamPart>({
    start(c) {
      controller = c;
      for (const part of parts) c.enqueue(part);
    },
  });
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      abortSignal?.addEventListener('abort', () =>
        controller.error(new DOMException('This operation was aborted', 'AbortError')),
      );
      return { stream };
    },
  });
}

const WRITTEN: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'reasoning-start', id: 'r' },
  { type: 'reasoning-delta', id: 'r', delta: '夕焼けにするか' },
  { type: 'reasoning-delta', id: 'r', delta: '考えている' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: '{"prompt": ' },
  { type: 'text-delta', id: 't', delta: '"girl, be' },
];

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

async function flush() {
  for (let i = 0; i < 50; i += 1) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a call that a person stops while the model is still writing', () => {
  it('throws an abort that carries the answer and the thinking written until then', async () => {
    const controller = new AbortController();
    const outcome = adapter(streamsThenSilent(WRITTEN)).generateStructured(call(controller.signal));
    const settled = outcome.then(
      () => undefined,
      (error: unknown) => error,
    );

    await flush();
    controller.abort();
    await flush();

    const error = await settled;
    expect(error).toBeInstanceOf(LlmCallAborted);
    expect((error as Error).name).toBe('AbortError');
    expect((error as LlmCallAborted).attempts).toEqual([
      expect.objectContaining({
        rawOutput: '{"prompt": "girl, be',
        reasoning: '夕焼けにするか考えている',
      }),
    ]);
  });

  it('keeps the earlier attempts that did not fit the schema, in front of the one that was cut', async () => {
    const controller = new AbortController();
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        n += 1;
        if (n === 1) {
          return {
            stream: new ReadableStream<StreamPart>({
              start(c) {
                for (const part of [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: '{"nope": 1}' },
                  { type: 'text-end', id: 't' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: {
                      inputTokens: {
                        total: 1,
                        noCache: 1,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                      },
                      outputTokens: { total: 1, text: 1, reasoning: undefined },
                    },
                  },
                ] as StreamPart[])
                  c.enqueue(part);
                c.close();
              },
            }),
          };
        }
        return {
          stream: new ReadableStream<StreamPart>({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: '{"prom' });
              abortSignal?.addEventListener('abort', () =>
                c.error(new DOMException('This operation was aborted', 'AbortError')),
              );
            },
          }),
        };
      },
    });
    const settled = adapter(model, 1)
      .generateStructured(call(controller.signal))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await flush();
    controller.abort();
    await flush();

    const error = await settled;
    expect(error).toBeInstanceOf(LlmCallAborted);
    const attempts = (error as LlmCallAborted).attempts;
    expect(attempts.map((a) => a.rawOutput)).toEqual(['{"nope": 1}', '{"prom']);
    expect(attempts[0]?.validationError).toBeDefined();
  });
});

describe('a call that times out while the model is still writing', () => {
  it('returns a failure whose attempt keeps the answer and the thinking written until then', async () => {
    const outcome = adapter(streamsThenSilent(WRITTEN)).generateStructured(call());
    const settled = outcome.then((value) => value as LlmCallOutcome<unknown>);

    await vi.advanceTimersByTimeAsync(300_000);
    await flush();

    const result = await settled;
    expect(result.ok).toBe(false);
    expect(result.attempts).toEqual([
      expect.objectContaining({
        rawOutput: '{"prompt": "girl, be',
        reasoning: '夕焼けにするか考えている',
      }),
    ]);
  });

  it('keeps what the talking role had written, in the attempt of the failed step', async () => {
    const parts: TalkStepPart[] = [];
    const done = (async () => {
      for await (const part of adapter(streamsThenSilent(WRITTEN)).streamStep({
        role: 'talk',
        messages: call().messages,
        tools: [],
        signal: new AbortController().signal,
      })) {
        parts.push(part);
      }
    })();

    await vi.advanceTimersByTimeAsync(300_000);
    await flush();
    await done;

    const finish = parts.at(-1);
    expect(finish?.type === 'finish' && finish.failure).toContain('時間内に答えなかった');
    expect(finish?.type === 'finish' && finish.attempts).toEqual([
      expect.objectContaining({
        rawOutput: '{"prompt": "girl, be',
        reasoning: '夕焼けにするか考えている',
      }),
    ]);
  });
});
