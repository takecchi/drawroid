import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  buildThinkInput,
  createCarry,
  DEFAULT_BUDGET,
  DEFAULT_MODEL_WINDOW,
  LLM_CALL_FAILED_PREFIX,
  THINK_PARAM_KEYS,
} from '@drawroid/core';
import {
  EmptyResponseBodyError,
  InvalidStreamPartError,
  NoOutputGeneratedError,
  TypeValidationError,
  UnsupportedFunctionalityError,
} from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AiSdkLlm, describeCallFailure } from './adapter.js';
import { roleConfigSchema } from './config.js';

// 失敗は、本物の OpenAI 互換の provider が、壊れた応答を返すサーバへ流しで呼んだときのものを使う（呼び出しの道は adapter と同じ）
let server: Server;
let reply: { status: number; type: string; body: string };
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(reply.status, { 'content-type': reply.type });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const config = roleConfigSchema.parse({ provider: 'local', model: 'm', structuredOutput: 'text' });

async function reasonFor(
  response: { status: number; type: string; body: string },
  networkRetries = 0,
): Promise<string> {
  reply = response;
  const model = createOpenAICompatible({
    name: 'local',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  }).chatModel('m');
  const llm = new AiSdkLlm(
    { think: config, judge: config, talk: config },
    {
      think: { providerName: 'local', model },
      judge: { providerName: 'local', model },
      talk: { providerName: 'local', model },
    },
    { validationRetries: 0, networkRetries },
  );
  const outcome = await llm.generateStructured({
    role: 'think',
    purpose: 'think',
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
  if (outcome.ok) throw new Error('失敗しなかった');
  return outcome.reason;
}

const sse = (chunks: unknown[]) =>
  chunks
    .map((chunk) => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`)
    .join('');
const delta = (content: string) => ({
  id: 'x',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'm',
  choices: [{ index: 0, delta: { content } }],
});

const UNREADABLE = `${LLM_CALL_FAILED_PREFIX}LLM の応答の形が読めなかった。LLM の設定の provider の種類と接続先（baseURL）が、使っている LLM のサーバに合っているかを確かめる。合っていれば、LLM のサーバの画面やログで、応答の途中で落ちていないかを見る（AI SDK の文: `;

describe('describeCallFailure and the kinds of AI SDK failures', () => {
  // 次の手（provider の種類と接続先を確かめる・サーバのログを見る）が同じなので、1つの言い方にまとめる
  it.each([
    [
      'an HTML page',
      { status: 200, type: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' },
    ],
    [
      'a stream that ends without a finish',
      { status: 200, type: 'text/event-stream', body: sse([delta('{"a"')]) },
    ],
    [
      'a chunk that is not JSON',
      { status: 200, type: 'text/event-stream', body: sse(['{not json']) },
    ],
    ['an empty stream', { status: 200, type: 'text/event-stream', body: '' }],
  ])('says the answer could not be read, for %s', async (_, response) => {
    const reason = await reasonFor(response);

    expect(reason.startsWith(UNREADABLE)).toBe(true);
  });

  // 上の通しで再現できなかった種類は、AI SDK の型そのもので作って、1つずつ縛る
  it.each([
    ['TypeValidationError', new TypeValidationError({ value: {}, cause: new Error('x') })],
    ['EmptyResponseBodyError', new EmptyResponseBodyError({})],
    ['InvalidStreamPartError', new InvalidStreamPartError({ chunk: {} as never, message: 'x' })],
    ['NoOutputGeneratedError', new NoOutputGeneratedError({})],
  ])('says the answer could not be read, for %s', (_, error) => {
    expect(describeCallFailure(error).startsWith(UNREADABLE)).toBe(true);
  });

  // 待って頼み直すのは 5xx と同じ手なので、同じ言い方にする
  it('says the server failed when it reports a failure in the middle of the stream', async () => {
    const reason = await reasonFor({
      status: 200,
      type: 'text/event-stream',
      body: sse([delta('{'), { error: { message: 'model crashed: out of memory' } }]),
    });

    expect(reason).toBe(
      `${LLM_CALL_FAILED_PREFIX}LLM のサーバが失敗を返した（応答の途中）。少し待ってから、もう一度頼む（LLM の返した理由: model crashed: out of memory）`,
    );
  });

  // 呼び直しが尽きた失敗は、包んだ文（Failed after 2 attempts…）ではなく、最後の失敗で言う。
  // 呼び直しは1回にする: AI SDK は呼び直しの前に2秒待つため
  it('tells the last failure when the retries ran out', { timeout: 15_000 }, async () => {
    const reason = await reasonFor(
      {
        status: 500,
        type: 'application/json',
        body: JSON.stringify({ error: { message: 'boom' } }),
      },
      1,
    );

    expect(reason).toBe(
      `${LLM_CALL_FAILED_PREFIX}LLM のサーバが失敗を返した（500）。少し待ってから、もう一度頼む（LLM の返した理由: boom）`,
    );
  });

  it('tells the role settings to change when the provider does not support the way it was used', () => {
    expect(
      describeCallFailure(
        new UnsupportedFunctionalityError({
          functionality: 'file part media type application/pdf',
        }),
      ),
    ).toBe(
      `${LLM_CALL_FAILED_PREFIX}この使い方に、LLM の provider が対応していない。LLM の設定で、その役の構造化出力・ツールの呼び出し方・画像を読めるかを、モデルに合わせて変える（AI SDK の文: 'file part media type application/pdf' functionality not supported.）`,
    );
  });

  // 見分けられない失敗は、今までどおり文をそのまま添える（言い当てられないことを言い当てたふりをしない）
  it('keeps the words of a failure it cannot tell apart', () => {
    expect(describeCallFailure(new Error('something else'))).toBe(
      `${LLM_CALL_FAILED_PREFIX}something else`,
    );
  });
});
