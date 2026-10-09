import {
  type ImageBackend,
  type JobStore,
  type ManualGenerationRunner,
  type MemoryStore,
} from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../index.js';
import { noCandidateNotes, noPermissionSettings, memoryBudgetSettings } from '../test-support.js';

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

  it('rejects an invalid config with 400 and stores nothing', async () => {
    const res = await put(makeApp({}), { providers: {}, roles: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_request' } });
    expect(written).toEqual([]);
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
