import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { LLM_CALL_FAILED_PREFIX } from '@drawroid/core';
import { generateText } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeCallFailure } from './adapter.js';

// 失敗は、本物の OpenAI 互換の provider が、断りを返すサーバへ呼んだときに投げるものを使う（手で作った失敗では、形がずれても気づけないため）
let server: Server;
let reply: { status: number; body: string };
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function failureFrom(baseURL: string): Promise<unknown> {
  const model = createOpenAICompatible({ name: 'fake', baseURL }).chatModel('m');
  try {
    await generateText({ model, prompt: 'こんにちは', maxRetries: 0 });
  } catch (error) {
    return error;
  }
  throw new Error('失敗しなかった');
}

const refusal = (message: string) => JSON.stringify({ error: { message, type: 'x', code: 'x' } });

describe('describeCallFailure', () => {
  it.each([
    [401, '鍵が通らない（401）。LLM の設定の API キーの環境変数と、その値を確かめる'],
    [403, '鍵が通らない（403）。'],
    [
      404,
      '接続先かモデルが見つからない（404）。LLM の設定の接続先（baseURL）とモデルの名前を確かめる',
    ],
    [429, '呼び出しの上限に当たった（429）。少し待ってから、もう一度頼む'],
    [500, 'LLM のサーバが失敗を返した（500）。少し待ってから、もう一度頼む'],
  ])(
    'says what happened and what to do when the LLM answers %i, keeping its own words',
    async (status, said) => {
      reply = { status, body: refusal('Incorrect API key provided: sk-****abcd') };
      const port = (server.address() as AddressInfo).port;

      const text = describeCallFailure(await failureFrom(`http://127.0.0.1:${port}/v1`));

      expect(text.startsWith(`${LLM_CALL_FAILED_PREFIX}${said}`)).toBe(true);
      expect(text).toContain('（LLM の返した理由: ');
      expect(text).toContain('Incorrect API key provided');
    },
  );

  it('says it cannot reach the LLM when nothing listens there', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const text = describeCallFailure(await failureFrom(`http://127.0.0.1:${port}/v1`));

    expect(text).toBe(
      `${LLM_CALL_FAILED_PREFIX}LLM に繋がらない（ECONNREFUSED）。LLM の設定の接続先（baseURL）と、LLM のサーバが起動しているかを確かめる`,
    );
  });

  // 見分けられない失敗は、今までどおり LLM の言葉をそのまま添える（言い当てられないことを言い当てたふりをしない）
  it('keeps the words of the LLM for a failure it cannot tell apart', async () => {
    reply = { status: 400, body: refusal('Unsupported parameter: tools') };
    const port = (server.address() as AddressInfo).port;

    const text = describeCallFailure(await failureFrom(`http://127.0.0.1:${port}/v1`));

    expect(text).toBe(`${LLM_CALL_FAILED_PREFIX}Unsupported parameter: tools`);
  });
});
