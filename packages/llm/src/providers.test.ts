import { buildJudgeInput, createCarry, DEFAULT_BUDGET, DEFAULT_MODEL_WINDOW } from '@drawroid/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlm } from './index.js';

const SECRET = 'sk-test-secret-value';

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

function fakeFetch(respond: (captured: Captured) => unknown, status = 200) {
  const calls: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(captured);
    return new Response(JSON.stringify(respond(captured)), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const judgeMessages = buildJudgeInput({
  carry: createCarry('夕暮れの海辺の少女', DEFAULT_BUDGET).carry,
  images: [
    { key: 'j/0001/0', data: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', longEdge: 512 },
  ],
  budget: DEFAULT_BUDGET,
  window: DEFAULT_MODEL_WINDOW,
});
const schema = z.object({ canStop: z.boolean() });
const judgeCall = {
  role: 'judge' as const,
  purpose: 'judge' as const,
  schema,
  messages: judgeMessages,
  signal: new AbortController().signal,
};

const chatCompletion = (text: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'qwen2.5vl:7b',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 },
});

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
    expect(JSON.stringify(request?.body.messages)).toContain('data:image/webp;base64,');
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
        return new Response(JSON.stringify(chatCompletion('{"canStop":true}')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

  it('names the missing environment variable without a value', () => {
    expect(() => createLlm(config('native'), { env: {} })).toThrow(/LOCAL_KEY/);
  });
});

describe('OpenAI provider', () => {
  it('sends the image to OpenAI and reads the structured output', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      id: 'resp_1',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"canStop":true}', annotations: [] }],
        },
      ],
      usage: { input_tokens: 400, output_tokens: 9, total_tokens: 409 },
    }));
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
    expect(JSON.stringify(calls[0]?.body)).toContain('data:image/webp;base64,');
  });
});

describe('Anthropic provider', () => {
  it('sends the image to Anthropic and reads the structured output', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: '{"canStop":false}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 8 },
    }));
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
    expect(JSON.stringify(calls[0]?.body)).toContain('"media_type":"image/webp"');
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
