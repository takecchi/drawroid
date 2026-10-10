import { describe, expect, it } from 'vitest';

import { llmConfigSchema } from './config.js';
import { describeDetectedContext, detectContextTokens } from './context.js';

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

  // llama.cpp の llama-server は、--alias を付けないと id にモデルのファイルのパスを出し、チャットは名前を問わずそのモデルで答える
  it('reads the window of the only model the server lists, even under another name, and names it', async () => {
    const { fetch } = modelsFetch({
      data: [{ id: '/models/qwen2.5-3b-instruct-q4_k_m.gguf', meta: { n_ctx: 8192 } }],
    });

    const { config: filled, detected } = await detectContextTokens(config(), { env: {}, fetch });

    expect(filled.roles.think.contextTokens).toBe(8192);
    expect(detected).toEqual([
      { role: 'think', contextTokens: 8192, onlyModel: '/models/qwen2.5-3b-instruct-q4_k_m.gguf' },
    ]);
  });

  it('does not borrow a window when the server lists several models and none has the name', async () => {
    const { fetch } = modelsFetch({
      data: [
        { id: 'first', meta: { n_ctx: 8192 } },
        { id: 'second', meta: { n_ctx: 4096 } },
      ],
    });

    const { config: filled, detected } = await detectContextTokens(config(), { env: {}, fetch });

    expect(filled.roles.think.contextTokens).toBeUndefined();
    expect(detected).toEqual([]);
  });

  it.each([
    ['meta is null', { id: '/models/a.gguf', meta: null }],
    ['the window is 0', { id: '/models/a.gguf', meta: { n_ctx: 0 } }],
    ['the window is not a number', { id: '/models/a.gguf', meta: { n_ctx: 'bad' } }],
    // id が無いと、どのモデルの窓かを端末に名指せないため
    ['it has no id', { meta: { n_ctx: 8192 } }],
  ])('leaves it unset when the only model listed is broken (%s)', async (_, broken) => {
    const { fetch } = modelsFetch({ data: [broken] });

    const { config: filled } = await detectContextTokens(config(), { env: {}, fetch });

    expect(filled.roles.think.contextTokens).toBeUndefined();
  });

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

  // 鍵の要る LLM のサーバでも窓を読む: 鍵を付けないと 401 で断られ、窓だけが黙って読めなくなるため
  it.each([
    ['sends the API key of the provider', { LOCAL_KEY: 'sk-local' }, 'Bearer sk-local'],
    ['sends no authorization when the key is not set', {}, null],
  ])('%s when it asks the server for the window', async (_, env, authorization) => {
    const sent: (string | null)[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ data: [{ id: 'qwen', meta: { n_ctx: 32768 } }] }));
    }) as typeof globalThis.fetch;
    const withKey = llmConfigSchema.parse({
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:8080/v1/',
          apiKeyEnv: 'LOCAL_KEY',
        },
      },
      roles: { think: { provider: 'local', model: 'qwen' } },
    });

    await detectContextTokens(withKey, { env, fetch });

    expect(sent).toEqual([authorization]);
  });

  // 答えないサーバを待ち続けない: 起動と設定の保存が、窓の読み取りで止まったままになるため
  it(
    'gives up on a server that does not answer, and leaves it unset',
    { timeout: 15_000 },
    async () => {
      const fetch = ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as typeof globalThis.fetch;

      const { config: filled, detected } = await detectContextTokens(config(), { env: {}, fetch });

      expect(filled.roles.think.contextTokens).toBeUndefined();
      expect(detected).toEqual([]);
    },
  );
});

describe('describeDetectedContext', () => {
  it('says the window it read for the role', () => {
    expect(describeDetectedContext({ role: 'talk', contextTokens: 32768 })).toBe(
      'drawroid: talk の役の文脈の上限を LLM から読んだ: 32768',
    );
  });

  // 名前が合わないまま読んだときは、どのモデルの窓かを見えるようにする: 思っていたモデルと違えば、人が気づけるように
  it('names the model it read from when it took the only model the server lists', () => {
    expect(
      describeDetectedContext({
        role: 'think',
        contextTokens: 8192,
        onlyModel: '/models/qwen2.5-3b-instruct-q4_k_m.gguf',
      }),
    ).toBe(
      'drawroid: think の役の文脈の上限を LLM から読んだ: 8192（/v1/models に1つだけあるモデル /models/qwen2.5-3b-instruct-q4_k_m.gguf の窓。設定のモデル名とは一致しない）',
    );
  });
});
