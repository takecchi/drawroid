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
/** 呼び直しごとに変える応答。空なら reply を返す */
let replies: { status: number; type: string; body: string }[] = [];
beforeAll(async () => {
  server = createServer((_req, res) => {
    const next = replies.shift() ?? reply;
    res.writeHead(next.status, { 'content-type': next.type });
    res.end(next.body);
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

  // 画像を読めないモデルの llama.cpp は、画像を渡すと 500 で「対応していない」と返す。待っても直らないので、待つよう促さない
  it.each([
    'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj',
    'tools are unsupported by this model',
    'This model does not support JSON schema',
    "This server doesn't support tool calls",
    'Vision Not Supported for this model',
  ])(
    'tells the settings to change, not to wait, when the server says it does not support it: %s',
    async (said) => {
      const reason = await reasonFor({
        status: 500,
        type: 'application/json',
        body: JSON.stringify({ error: { message: said } }),
      });

      expect(reason).toBe(
        `${LLM_CALL_FAILED_PREFIX}LLM のサーバが、この使い方に対応していないと返した（500）。待っても直らない。LLM の設定で、その役のモデルと、構造化出力・ツールの呼び出し方・画像を読めるかを、モデルに合わせて見直す（LLM の返した理由: ${said}）`,
      );
    },
  );

  // 応答の途中の失敗も 5xx と同じ枝なので、「対応していない」と言うなら待つよう促さない
  it('tells the settings to change when the server says it does not support it in the middle of the stream', async () => {
    const reason = await reasonFor({
      status: 200,
      type: 'text/event-stream',
      body: sse([delta('{'), { error: { message: 'image input is not supported' } }]),
    });

    expect(reason).toBe(
      `${LLM_CALL_FAILED_PREFIX}LLM のサーバが、この使い方に対応していないと返した（応答の途中）。待っても直らない。LLM の設定で、その役のモデルと、構造化出力・ツールの呼び出し方・画像を読めるかを、モデルに合わせて見直す（LLM の返した理由: image input is not supported）`,
    );
  });

  // 理由の文は画面に出すときだけ切り詰める。「対応していない」が切った先にあっても見分ける
  it('tells the settings to change when the server says it does not support it after a long reason', async () => {
    const said = `${'llama_model_load: tensor data is not aligned; '.repeat(8)}image input is not supported`;
    const reason = await reasonFor({
      status: 500,
      type: 'application/json',
      body: JSON.stringify({ error: { message: said } }),
    });

    expect(reason).toContain(
      'LLM のサーバが、この使い方に対応していないと返した（500）。待っても直らない。',
    );
    expect(reason).not.toContain('少し待ってから');
    // 見分けに使うのは切り詰める前の文でも、画面に出す理由の文は 300 字で切ったまま
    expect(reason).toContain(`（LLM の返した理由: ${said.slice(0, 300)}…）`);
    expect(reason).not.toContain(said);
  });

  // 呼び直しの途中で失敗の種類が変わったら、最後の失敗の種類で言う: 最初の失敗（500）で言うと、鍵を直す手が出ないため
  it(
    'tells the kind of the last failure when it differs from the first',
    { timeout: 15_000 },
    async () => {
      replies = [
        {
          status: 500,
          type: 'application/json',
          body: JSON.stringify({ error: { message: 'boom' } }),
        },
        {
          status: 401,
          type: 'application/json',
          body: JSON.stringify({ error: { message: 'invalid api key' } }),
        },
      ];
      const reason = await reasonFor(replies[1]!, 1);

      expect(reason).toBe(
        `${LLM_CALL_FAILED_PREFIX}鍵が通らない（401）。LLM の設定の API キーの環境変数と、その値を確かめる（LLM の返した理由: invalid api key）`,
      );
    },
  );

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
