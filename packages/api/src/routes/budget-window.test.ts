// 予算の欄ごとの上限の和が役の窓を超える組み合わせを、予算の保存と LLM 設定の保存のどちらでも断ることを見る試験
import {
  DEFAULT_BUDGETS,
  type BudgetOverrides,
  type ImageBackend,
  type JobStore,
  type LlmRole,
  type ManualGenerationRunner,
  type MemoryStore,
  type ModelWindow,
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

const ROOMY: ModelWindow = { contextTokens: 8192, maxOutputTokens: 1024 };

let savedLlm: LlmConfig | undefined;
let currentWindows: Partial<Record<LlmRole, ModelWindow>>;

// 渡された LLM の設定では、contextTokens を書いた役だけ窓が分かる。省けば、いま効いている窓（試験が決める）
async function inputWindows(llm?: LlmConfig): Promise<Partial<Record<LlmRole, ModelWindow>>> {
  if (llm === undefined) return currentWindows;
  const windows: Partial<Record<LlmRole, ModelWindow>> = {};
  for (const [role, config] of Object.entries(llm.roles) as [
    LlmRole,
    LlmConfig['roles']['think'],
  ][]) {
    if (config?.contextTokens === undefined) continue;
    windows[role] = {
      contextTokens: config.contextTokens,
      maxOutputTokens: config.maxOutputTokens ?? 1024,
    };
  }
  return windows;
}

function makeApp(budgets: BudgetOverrides = {}) {
  const budgetSettings = memoryBudgetSettings(budgets);
  const app = createApi({
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
    budgetSettings,
    ...memoryProgressDeps(),
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    llmSettings: {
      read: async () => savedLlm,
      write: async (config) => {
        savedLlm = config;
      },
    },
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    conversations: memoryConversations(),
    env: {},
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
    inputWindows,
  });
  return { app, budgetSettings };
}

const put = (app: ReturnType<typeof makeApp>['app'], path: string, body: unknown) =>
  app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// 候補の文字数の上限を既定の20倍に広げると、種類ごとに積もって、考える段の削れない部分が窓を超える
const heavyCandidates: BudgetOverrides = {
  candidates: { maxSize: DEFAULT_BUDGETS.candidates.maxSize! * 20 },
};

beforeEach(() => {
  savedLlm = undefined;
  currentWindows = { think: ROOMY, judge: ROOMY };
});

describe('saving budgets whose sum goes over a window', () => {
  it('refuses them with 400, naming the role, the stage and how much is over, and keeps the old budgets', async () => {
    const { app, budgetSettings } = makeApp();
    const res = await put(app, '/settings/budgets', heavyCandidates);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe('invalid_request');
    expect(body.error.message).toMatch(/考える役の考える段.*8192.*1024.*トークン超える/);
    expect((await budgetSettings.read()).overrides).toEqual({});
  });

  it('saves budgets that fit', async () => {
    const { app, budgetSettings } = makeApp();
    const res = await put(app, '/settings/budgets', { candidates: { maxSize: 650 } });

    expect(res.status).toBe(200);
    expect((await budgetSettings.read()).overrides).toEqual({ candidates: { maxSize: 650 } });
  });

  it('saves them when no window is known', async () => {
    currentWindows = {};
    const { app, budgetSettings } = makeApp();
    const res = await put(app, '/settings/budgets', heavyCandidates);

    expect(res.status).toBe(200);
    expect((await budgetSettings.read()).overrides).toEqual(heavyCandidates);
  });
});

describe('saving LLM settings whose window is too small for the budgets', () => {
  const llmWith = (contextTokens?: number) => ({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
    roles: {
      think: {
        provider: 'local',
        model: 'm',
        ...(contextTokens === undefined ? {} : { contextTokens }),
      },
    },
  });

  it('refuses them with 400 and stores nothing', async () => {
    const { app } = makeApp();
    const res = await put(app, '/settings/llm', llmWith(1500));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/考える役の考える段.*1500.*トークン超える/);
    expect(savedLlm).toBeUndefined();
  });

  it('stores them when the window fits, or when the window is left to the LLM', async () => {
    const { app } = makeApp();
    expect((await put(app, '/settings/llm', llmWith(8192))).status).toBe(200);
    expect((await put(app, '/settings/llm', llmWith())).status).toBe(200);
  });

  it('compares the window with the saved budgets', async () => {
    const { app } = makeApp(heavyCandidates);
    const res = await put(app, '/settings/llm', llmWith(8192));

    expect(res.status).toBe(400);
  });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
