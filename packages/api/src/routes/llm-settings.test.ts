import {
  type ImageBackend,
  type JobStore,
  type ManualGenerationRunner,
  type MemoryStore,
} from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../index.js';
import {
  noCandidateNotes,
  noPermissionSettings,
  memoryBudgetSettings,
  memoryProgressDeps,
  memoryConversations,
} from '../test-support.js';

const SECRET = 'sk-should-not-leak';

const config = {
  providers: {
    cloud: { type: 'anthropic', apiKeyEnv: 'TEST_KEY' },
    local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' },
  },
  roles: { think: { provider: 'cloud', model: 'claude-haiku-5-5' } },
};

let saved: unknown;
let written: LlmConfig[];

function makeApp(env: Record<string, string | undefined>) {
  return createApi({
    // 設定の経路はジョブとバックエンドを使わない
    backend: {} as ImageBackend,
    store: {} as JobStore,
    memoryStore: {} as MemoryStore,
    manualRunner: {} as ManualGenerationRunner,
    autoQueue: {
      kick: () => undefined,
      stop: async () => undefined,
      addInstruction: notUsed,
      changeStopConditions: notUsed,
      addReference: notUsed,
      addMask: notUsed,
    },
    budgetSettings: memoryBudgetSettings(),
    ...memoryProgressDeps(),
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    llmSettings: {
      read: async () => saved,
      write: async (c) => {
        written.push(c);
        saved = c;
      },
    },
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    conversations: memoryConversations(),
    env,
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
  });
}

const put = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.request('/settings/llm', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  saved = undefined;
  written = [];
});

describe('GET /settings/llm', () => {
  it('answers null when nothing is configured', async () => {
    const res = await makeApp({}).request('/settings/llm');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config: null });
  });

  it.each([
    ['empty', ''],
    ['missing', undefined],
  ])('reports a stored config whose API key env var is %s as not set', async (_, value) => {
    saved = config;
    const res = await makeApp({ TEST_KEY: value }).request('/settings/llm');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      apiKeyEnv: { cloud: { name: 'TEST_KEY', set: false } },
    });
  });

  it('answers 500 invalid_config when the stored settings are broken', async () => {
    saved = { providers: {} };
    const res = await makeApp({}).request('/settings/llm');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_config' } });
  });

  it('names the broken field of the stored settings in Japanese, with the original message behind', async () => {
    saved = { providers: {}, roles: {} };
    const res = await makeApp({}).request('/settings/llm');
    expect(await res.json()).toEqual({
      error: {
        kind: 'invalid_config',
        message:
          'config.json の llm.roles.think が読めない（欄が無い）（原文: Invalid input: expected object, received undefined）',
      },
    });
  });
});

describe('GET /settings/llm with an empty model', () => {
  it('says the own Japanese message of the schema once, without the original message behind', async () => {
    saved = { ...config, roles: { think: { provider: 'cloud', model: '' } } };
    const res = await makeApp({}).request('/settings/llm');
    expect(await res.json()).toEqual({
      error: {
        kind: 'invalid_config',
        message: 'config.json の llm.roles.think.model: 考える役のモデルの名前を入れる',
      },
    });
  });
});

describe('PUT /settings/llm', () => {
  it('stores a valid config and reports whether each env var is set', async () => {
    const res = await put(makeApp({ TEST_KEY: SECRET }), config);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: LlmConfig; apiKeyEnv: unknown };
    expect(body.apiKeyEnv).toEqual({ cloud: { name: 'TEST_KEY', set: true } });
    expect(body.config.roles.think.model).toBe('claude-haiku-5-5');
    expect(written).toHaveLength(1);
  });

  it.each([
    ['empty', ''],
    ['missing', undefined],
  ])(
    'rejects a config whose API key env var is %s, names the variable, and stores nothing',
    async (_, value) => {
      const res = await put(makeApp({ TEST_KEY: value }), config);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { kind: 'invalid_request', message: expect.stringContaining('TEST_KEY') },
      });
      expect(written).toEqual([]);
    },
  );

  it('rejects a cloud provider that does not name its API key env var, and stores nothing', async () => {
    const res = await put(makeApp({ TEST_KEY: SECRET }), {
      ...config,
      providers: { cloud: { type: 'anthropic' } },
    });
    expect(res.status).toBe(400);
    expect(written).toEqual([]);
  });

  it('reads back what was stored', async () => {
    const app = makeApp({ TEST_KEY: SECRET });
    await put(app, config);
    const res = await app.request('/settings/llm');
    expect(await res.json()).toMatchObject({
      config: { roles: { think: { provider: 'cloud' } } },
      apiKeyEnv: { cloud: { name: 'TEST_KEY', set: true } },
    });
  });

  it('stores the limit on the whole time of one LLM call and reads it back', async () => {
    const app = makeApp({ TEST_KEY: SECRET });
    const res = await put(app, { ...config, totalCallTimeoutSeconds: 1800 });
    expect(res.status).toBe(200);
    expect(written[0]?.totalCallTimeoutSeconds).toBe(1800);
    expect(await (await app.request('/settings/llm')).json()).toMatchObject({
      config: { totalCallTimeoutSeconds: 1800 },
    });
  });

  it('leaves the limit on the whole time of one LLM call unwritten when it is left out', async () => {
    const res = await put(makeApp({ TEST_KEY: SECRET }), config);
    expect(res.status).toBe(200);
    expect(written[0]).not.toHaveProperty('totalCallTimeoutSeconds');
    expect(((await res.json()) as { config: LlmConfig }).config).not.toHaveProperty(
      'totalCallTimeoutSeconds',
    );
  });

  it('rejects a limit on the whole time that is zero, and stores nothing', async () => {
    const res = await put(makeApp({ TEST_KEY: SECRET }), { ...config, totalCallTimeoutSeconds: 0 });
    expect(res.status).toBe(400);
    expect(written).toEqual([]);
  });

  it('rejects an invalid config with 400 and stores nothing', async () => {
    const res = await put(makeApp({}), { providers: {}, roles: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_request' } });
    expect(written).toEqual([]);
  });
});

describe('PUT /settings/llm refusing the input', () => {
  const messageOf = async (res: Response) =>
    ((await res.json()) as { error: { message: string } }).error.message;

  it('says the wrong field in Japanese with the original message in parentheses behind', async () => {
    const res = await put(makeApp({ TEST_KEY: SECRET }), { ...config, validationRetries: -1 });
    expect(res.status).toBe(400);
    expect(await messageOf(res)).toMatch(/^validationRetries の値が違う（.+）（原文: .+）$/);
    expect(written).toEqual([]);
  });

  it('says the own Japanese message of the schema once, without the original message behind', async () => {
    const res = await put(makeApp({ TEST_KEY: SECRET }), {
      ...config,
      roles: { think: { provider: 'cloud', model: '' } },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        kind: 'invalid_request',
        message: 'roles.think.model: 考える役のモデルの名前を入れる',
      },
    });
  });

  it('does not blame config.json, because the input is not the stored file', async () => {
    const wrongField = await put(makeApp({}), { ...config, validationRetries: -1 });
    const emptyModel = await put(makeApp({}), {
      ...config,
      roles: { think: { provider: 'cloud', model: '' } },
    });
    expect(await messageOf(wrongField)).not.toContain('config.json');
    expect(await messageOf(emptyModel)).not.toContain('config.json');
  });
});

describe('API key values', () => {
  it('never appear in the responses of PUT and GET', async () => {
    const app = makeApp({ TEST_KEY: SECRET });
    const putText = await (await put(app, config)).text();
    const getText = await (await app.request('/settings/llm')).text();
    expect(putText).not.toContain(SECRET);
    expect(getText).not.toContain(SECRET);
  });

  it('are rejected when written into the config, and not echoed back', async () => {
    const res = await put(makeApp({}), {
      ...config,
      providers: { cloud: { type: 'anthropic', apiKey: SECRET } },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(SECRET);
    expect(written).toEqual([]);
  });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
