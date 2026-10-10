import { describe, expect, it } from 'vitest';

import { llmConfigSchema } from './config.js';
import { detectContextTokens } from './context.js';

const config = (contextTokens?: number) =>
  llmConfigSchema.parse({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:8080/v1/' } },
    roles: {
      think: { provider: 'local', model: 'qwen', ...(contextTokens && { contextTokens }) },
    },
  });

function modelsFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

describe('detectContextTokens', () => {
  it('fills the context length the server reports for the model', async () => {
    const { fetch, urls } = modelsFetch({
      data: [
        { id: 'other', meta: { n_ctx: 4096 } },
        { id: 'qwen', meta: { n_ctx: 32768 } },
      ],
    });
    const { config: filled, detected } = await detectContextTokens(config(), { env: {}, fetch });
    expect(filled.roles.think.contextTokens).toBe(32768);
    expect(detected).toEqual([{ role: 'think', contextTokens: 32768 }]);
    expect(urls).toEqual(['http://127.0.0.1:8080/v1/models']);
  });

  it('keeps the configured context length without asking the server', async () => {
    const { fetch, urls } = modelsFetch({ data: [{ id: 'qwen', meta: { n_ctx: 32768 } }] });
    const { config: filled } = await detectContextTokens(config(4096), { env: {}, fetch });
    expect(filled.roles.think.contextTokens).toBe(4096);
    expect(urls).toEqual([]);
  });

  it('fills the context length of a talking role set apart from the thinking role, too', async () => {
    const { fetch } = modelsFetch({
      data: [
        { id: 'qwen', meta: { n_ctx: 32768 } },
        { id: 'talker', meta: { n_ctx: 16384 } },
      ],
    });
    const withTalk = llmConfigSchema.parse({
      ...config(),
      roles: { ...config().roles, talk: { provider: 'local', model: 'talker' } },
    });

    const { config: filled, detected } = await detectContextTokens(withTalk, { env: {}, fetch });

    expect(filled.roles.talk?.contextTokens).toBe(16384);
    expect(filled.roles.think.contextTokens).toBe(32768);
    expect(detected).toEqual([
      { role: 'think', contextTokens: 32768 },
      { role: 'talk', contextTokens: 16384 },
    ]);
  });

  it('keeps the context length a talking role sets for itself, without asking the server for it', async () => {
    const { fetch, urls } = modelsFetch({
      data: [
        { id: 'qwen', meta: { n_ctx: 32768 } },
        { id: 'talker', meta: { n_ctx: 16384 } },
      ],
    });
    const withTalk = llmConfigSchema.parse({
      ...config(),
      roles: {
        ...config().roles,
        talk: { provider: 'local', model: 'talker', contextTokens: 2048 },
      },
    });

    const { config: filled, detected } = await detectContextTokens(withTalk, { env: {}, fetch });

    expect(filled.roles.talk?.contextTokens).toBe(2048);
    expect(detected).toEqual([{ role: 'think', contextTokens: 32768 }]);
    expect(urls).toHaveLength(1);
  });

  it('does not make up a talking role when the talking role follows the thinking role', async () => {
    const { fetch } = modelsFetch({ data: [{ id: 'qwen', meta: { n_ctx: 32768 } }] });

    const { config: filled } = await detectContextTokens(config(), { env: {}, fetch });

    expect(filled.roles.talk).toBeUndefined();
  });

  it.each([
    ['the server does not report it', modelsFetch({ data: [{ id: 'qwen' }] })],
    ['the server fails', modelsFetch({ error: 'down' }, 500)],
  ])('leaves it unset when %s', async (_, { fetch }) => {
    const { config: filled, detected } = await detectContextTokens(config(), { env: {}, fetch });
    expect(filled.roles.think.contextTokens).toBeUndefined();
    expect(detected).toEqual([]);
  });

  // ほかのモデルの欄が崩れていても、そのモデルの窓は読む: 一覧には、読み込んでいないモデルも窓の無い形で並ぶことがあるため
  it.each([
    ['meta is null', { id: 'other', meta: null }],
    ['the window is 0', { id: 'other', meta: { n_ctx: 0 } }],
    ['the window is not a number', { id: 'other', meta: { n_ctx: 'bad' } }],
    ['it has no id', { meta: { n_ctx: 4096 } }],
    ['it is not an object', 'other'],
  ])(
    'reads the window of the model when another entry in the list is broken (%s)',
    async (_, broken) => {
      const { fetch } = modelsFetch({ data: [broken, { id: 'qwen', meta: { n_ctx: 32768 } }] });

      const { config: filled } = await detectContextTokens(config(), { env: {}, fetch });

      expect(filled.roles.think.contextTokens).toBe(32768);
    },
  );

  // そのモデルの欄が崩れていたら、ほかのモデルの窓で埋めない
  it.each([
    ['meta is null', { id: 'qwen', meta: null }],
    ['the window is 0', { id: 'qwen', meta: { n_ctx: 0 } }],
    ['the window is not a number', { id: 'qwen', meta: { n_ctx: 'bad' } }],
  ])('leaves it unset when the entry of the model itself is broken (%s)', async (_, broken) => {
    const { fetch } = modelsFetch({ data: [{ id: 'other', meta: { n_ctx: 4096 } }, broken] });

    const { config: filled } = await detectContextTokens(config(), { env: {}, fetch });

    expect(filled.roles.think.contextTokens).toBeUndefined();
  });
});
