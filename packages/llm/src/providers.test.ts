import { buildJudgeInput, createCarry, DEFAULT_BUDGET, DEFAULT_MODEL_WINDOW } from '@drawroid/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlm } from './index.js';

const SECRET = 'sk-test-secret-value';

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

/** サーバが流す SSE。drawroid は LLM をストリームで呼ぶ（思考の増分を見せるため） */
class Sse {
  constructor(
    readonly events: { event?: string; data: unknown }[],
    readonly done = false,
  ) {}

  toResponse(): Response {
    const lines = this.events.map(
      ({ event, data }) =>
        `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`,
    );
    if (this.done) lines.push('data: [DONE]\n\n');
    return new Response(lines.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
}

function fakeFetch(respond: (captured: Captured) => unknown, status = 200) {
  const calls: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(captured);
    const body = respond(captured);
    if (body instanceof Sse) return body.toResponse();
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** storage-fs が作る縮小版と同じ形（webp・長辺 512） */
const preview = new Uint8Array(
  await sharp({
    create: { width: 512, height: 350, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .webp()
    .toBuffer(),
);
const previewPart = { key: 'j/0001/0', data: preview, mediaType: 'image/webp', longEdge: 512 };
const judgeMessages = buildJudgeInput({
  carry: createCarry('夕暮れの海辺の少女', DEFAULT_BUDGET).carry,
  images: [previewPart],
  budget: DEFAULT_BUDGET,
  window: DEFAULT_MODEL_WINDOW,
});

/** 送られた本文に載った画像（data URL）を、形式と中身にして取り出す */
function sentImages(body: unknown): { mediaType: string; data: Buffer }[] {
  return [
    ...JSON.stringify(body).matchAll(/data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)/g),
  ].map((m) => ({ mediaType: m[1]!, data: Buffer.from(m[2]!, 'base64') }));
}
const schema = z.object({ canStop: z.boolean() });
const judgeCall = {
  role: 'judge' as const,
  purpose: 'judge' as const,
  schema,
  messages: judgeMessages,
  signal: new AbortController().signal,
};

/** OpenAI 互換の chat completions のストリーム。reasoning_content があれば思考として先に流す */
const chatCompletion = (text: string, reasoning?: string) => {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    data: {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'qwen2.5vl:7b',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    },
  });
  return new Sse(
    [
      ...(reasoning === undefined
        ? []
        : [chunk({ role: 'assistant', reasoning_content: reasoning }, null)]),
      chunk({ role: 'assistant', content: text }, null),
      chunk({}, 'stop', {
        usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 },
      }),
    ],
    true,
  );
};

describe('OpenAI-compatible provider (Ollama, LM Studio, ...)', () => {
  const config = (structuredOutput: string) => ({
    providers: {
      local: {
        type: 'openai-compatible',
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKeyEnv: 'LOCAL_KEY',
      },
    },
    roles: { think: { provider: 'local', model: 'qwen2.5vl:7b', structuredOutput } },
    networkRetries: 0,
  });

  it('sends the image and the JSON Schema to the chat completions endpoint and reads usage', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('{"canStop":true}'));
    const llm = createLlm(config('native'), { env: { LOCAL_KEY: SECRET }, fetch });
    const outcome = await llm.generateStructured(judgeCall);

    expect(outcome).toMatchObject({ ok: true, value: { canStop: true } });
    expect(outcome.attempts[0]?.usage).toEqual({ inputTokens: 321, outputTokens: 12 });
    const request = calls[0];
    expect(request?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(request?.body).toMatchObject({
      model: 'qwen2.5vl:7b',
      response_format: { type: 'json_schema' },
    });
    expect(JSON.stringify(request?.body.messages)).toContain('data:image/jpeg;base64,');
  });

  // llama.cpp（b11531）は webp の画像を、この形の 400 で断る（2026-10-09 の実機の記録）
  const llamaCppRejectsWebp = (captured: Captured) =>
    JSON.stringify(captured.body).includes('data:image/webp')
      ? {
          error: {
            code: 400,
            message: 'Failed to load image or audio file',
            type: 'invalid_request_error',
          },
        }
      : chatCompletion('{"canStop":false}');

  it('shows the judge the webp preview as a JPEG of the same size, which llama.cpp can read', async () => {
    const { fetch, calls } = fakeFetch(llamaCppRejectsWebp, 400);
    const llm = createLlm(config('native'), { env: { LOCAL_KEY: SECRET }, fetch });

    const outcome = await llm.generateStructured(judgeCall);

    expect(outcome).toMatchObject({ ok: true, value: { canStop: false } });
    const images = sentImages(calls[0]?.body);
    expect(images.map((image) => image.mediaType)).toEqual(['image/jpeg']);
    const meta = await sharp(images[0]!.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 512, 350]);
  });

  // 変えるのは送る分だけ: 呼び手の縮小版（保存したもの・画面に出すもの）は webp のまま
  it('leaves the caller’s preview as it was', async () => {
    const before = Buffer.from(preview);
    const { fetch } = fakeFetch(() => chatCompletion('{"canStop":false}'));
    await createLlm(config('native'), { env: { LOCAL_KEY: SECRET }, fetch }).generateStructured(
      judgeCall,
    );

    const image = judgeMessages.user.find((part) => part.type === 'image');
    expect(image?.mediaType).toBe('image/webp');
    expect(Buffer.from(image!.data).equals(before)).toBe(true);
  });

  it('sends a PNG or JPEG image as it is', async () => {
    const png = new Uint8Array(await sharp(preview).png().toBuffer());
    const messages = buildJudgeInput({
      carry: createCarry('夕暮れの海辺の少女', DEFAULT_BUDGET).carry,
      images: [{ ...previewPart, data: png, mediaType: 'image/png' }],
      budget: DEFAULT_BUDGET,
      window: DEFAULT_MODEL_WINDOW,
    });
    const { fetch, calls } = fakeFetch(() => chatCompletion('{"canStop":false}'));
    await createLlm(config('native'), { env: { LOCAL_KEY: SECRET }, fetch }).generateStructured({
      ...judgeCall,
      messages,
    });

    const images = sentImages(calls[0]?.body);
    expect(images.map((image) => image.mediaType)).toEqual(['image/png']);
    expect(images[0]!.data.equals(Buffer.from(png))).toBe(true);
  });

  it('asks for json_object without a schema in json mode', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('{"canStop":false}'));
    const llm = createLlm(config('json'), { env: { LOCAL_KEY: SECRET }, fetch });
    await llm.generateStructured(judgeCall);
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
  });

  it('does not put the API key into the failure reason', async () => {
    const { fetch } = fakeFetch(() => ({ error: { message: 'invalid api key' } }), 401);
    const llm = createLlm(config('native'), { env: { LOCAL_KEY: SECRET }, fetch });
    const outcome = await llm.generateStructured(judgeCall);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('sends the role maxOutputTokens as the limit of the output', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('{"canStop":true}'));
    const base = config('native');
    const llm = createLlm(
      {
        ...base,
        roles: { think: { ...base.roles.think, maxOutputTokens: 777 } },
      },
      { env: { LOCAL_KEY: SECRET }, fetch },
    );
    await llm.generateStructured(judgeCall);
    expect(calls[0]?.body.max_tokens).toBe(777);
  });

  it('leaves the limit of the output to the provider when the role has no maxOutputTokens', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('{"canStop":true}'));
    const llm = createLlm(config('native'), { env: { LOCAL_KEY: SECRET }, fetch });
    await llm.generateStructured(judgeCall);
    expect(calls[0]?.body).not.toHaveProperty('max_tokens');
  });

  it.each([500, 429])(
    'succeeds when the first request fails with %i and a network retry succeeds',
    async (failure) => {
      let count = 0;
      const fetch = async () => {
        count += 1;
        if (count === 1) {
          return new Response(JSON.stringify({ error: { message: 'busy' } }), {
            status: failure,
            headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
          });
        }
        return chatCompletion('{"canStop":true}').toResponse();
      };
      const llm = createLlm(
        { ...config('native'), networkRetries: 1 },
        { env: { LOCAL_KEY: SECRET }, fetch: fetch as typeof globalThis.fetch },
      );
      const outcome = await llm.generateStructured(judgeCall);
      expect(outcome).toMatchObject({ ok: true, value: { canStop: true } });
      expect(count).toBe(2);
    },
  );

  it('reads the reasoning the server sends in reasoning_content as thinking', async () => {
    const { fetch } = fakeFetch(() => chatCompletion('{"canStop":true}', '光の向きを確かめた'));
    const llm = createLlm(config('native'), { env: { LOCAL_KEY: SECRET }, fetch });
    const thoughts: string[] = [];
    const outcome = await llm.generateStructured({
      ...judgeCall,
      onReasoning: (text) => thoughts.push(text),
    });
    expect(outcome).toMatchObject({ ok: true, value: { canStop: true } });
    expect(thoughts.join('')).toBe('光の向きを確かめた');
  });

  it('splits <think> in the text into thinking with reasoning: think-tag', async () => {
    const { fetch } = fakeFetch(() =>
      chatCompletion('<think>{"canStop":false} かな</think>{"canStop":true}'),
    );
    const base = config('json');
    const llm = createLlm(
      { ...base, roles: { think: { ...base.roles.think, reasoning: 'think-tag' } } },
      { env: { LOCAL_KEY: SECRET }, fetch },
    );
    const thoughts: string[] = [];
    const outcome = await llm.generateStructured({
      ...judgeCall,
      onReasoning: (text) => thoughts.push(text),
    });
    expect(outcome).toMatchObject({ ok: true, value: { canStop: true } });
    expect(thoughts.join('')).toBe('{"canStop":false} かな');
    expect(outcome.attempts[0]?.rawOutput).toBe('{"canStop":true}');
  });

  it('names the missing environment variable without a value', () => {
    expect(() => createLlm(config('native'), { env: {} })).toThrow(/LOCAL_KEY/);
  });
});

describe('OpenAI provider', () => {
  it('sends the image to OpenAI and reads the structured output', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Sse([
          {
            data: {
              type: 'response.created',
              response: { id: 'resp_1', created_at: 0, model: 'gpt-5', service_tier: null },
            },
          },
          {
            data: {
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'message', id: 'msg_1' },
            },
          },
          {
            data: {
              type: 'response.output_text.delta',
              item_id: 'msg_1',
              output_index: 0,
              content_index: 0,
              delta: '{"canStop":true}',
            },
          },
          {
            data: {
              type: 'response.output_item.done',
              output_index: 0,
              item: { type: 'message', id: 'msg_1' },
            },
          },
          {
            data: {
              type: 'response.completed',
              response: {
                incomplete_details: null,
                usage: { input_tokens: 400, output_tokens: 9 },
                service_tier: null,
              },
            },
          },
        ]),
    );
    const llm = createLlm(
      {
        providers: { openai: { type: 'openai', apiKeyEnv: 'OPENAI_API_KEY' } },
        roles: { think: { provider: 'openai', model: 'gpt-5' } },
        networkRetries: 0,
      },
      { env: { OPENAI_API_KEY: SECRET }, fetch },
    );
    const outcome = await llm.generateStructured(judgeCall);
    expect(outcome).toMatchObject({ ok: true, value: { canStop: true } });
    expect(outcome.attempts[0]?.usage).toEqual({ inputTokens: 400, outputTokens: 9 });
    expect(calls[0]?.url).toMatch(/^https:\/\/api\.openai\.com\/v1\//);
    expect(JSON.stringify(calls[0]?.body)).toContain('data:image/jpeg;base64,');
  });
});

describe('Anthropic provider', () => {
  it('sends the image to Anthropic and reads the structured output', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Sse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-haiku-5-5',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 500, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: '{"canStop":false}' },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 8 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
    );
    const llm = createLlm(
      {
        providers: { anthropic: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' } },
        roles: { think: { provider: 'anthropic', model: 'claude-haiku-5-5' } },
        networkRetries: 0,
      },
      { env: { ANTHROPIC_API_KEY: SECRET }, fetch },
    );
    const outcome = await llm.generateStructured(judgeCall);
    expect(outcome).toMatchObject({ ok: true, value: { canStop: false } });
    expect(outcome.attempts[0]?.usage).toEqual({ inputTokens: 500, outputTokens: 8 });
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.stringify(calls[0]?.body)).toContain('"media_type":"image/jpeg"');
  });
});

describe('API key environment variable', () => {
  it.each(['openai', 'anthropic'] as const)(
    'is required for the %s provider, so a missing key is found before any call',
    (type) => {
      expect(() =>
        createLlm(
          { providers: { cloud: { type } }, roles: { think: { provider: 'cloud', model: 'm' } } },
          { env: { OPENAI_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET } },
        ),
      ).toThrow(/apiKeyEnv/);
    },
  );
});
