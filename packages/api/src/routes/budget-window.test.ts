// 予算の欄ごとの上限の和が役の窓を超える組み合わせを、予算の保存と LLM 設定の保存のどちらでも断ることを見る試験
import {
  DEFAULT_BUDGETS,
  findInputOverflows,
  resolveBudgets,
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
      // 本物と同じく、書いたあとに設定を効かせ直し、いま効いている窓をその設定のものにする。
      // 効かせ直すまでの間を置く: 本物は LLM から窓を読むので、書いてから窓が替わるまでに時間がかかるため
      write: async (config) => {
        savedLlm = config;
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentWindows = await inputWindows(config);
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
    // どの欄を減らせばよいかも添える
    expect(body.error.message).toMatch(/考える段.*いちばん大きく効いている欄は candidates\.maxSize/);
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

// 2つの画面（または API）から、予算と LLM の設定を同時に保存する。どちらも相手の保存の前の値と比べると、
// 両方とも通って、窓に入らない組み合わせが残る
describe('saving budgets and LLM settings at the same time', () => {
  const llmWith = (contextTokens: number) => ({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
    roles: { think: { provider: 'local', model: 'm', contextTokens } },
  });
  const WIDE: ModelWindow = { contextTokens: 131072, maxOutputTokens: 1024 };

  it.each([
    ['budgets first', true],
    ['LLM settings first', false],
  ])('takes only one of them, so what is saved still fits (%s)', async (_, budgetsFirst) => {
    currentWindows = { think: WIDE, judge: WIDE };
    const { app, budgetSettings } = makeApp();
    // 前提: 重い予算は広い窓に入り、狭い窓の LLM の設定は既定の予算に入る（それぞれ単独なら通る）
    expect(findInputOverflows(resolveBudgets(heavyCandidates), currentWindows)).toEqual([]);
    expect(findInputOverflows(DEFAULT_BUDGETS, { think: ROOMY })).toEqual([]);

    const saveBudgets = () => put(app, '/settings/budgets', heavyCandidates);
    const saveLlm = () => put(app, '/settings/llm', llmWith(ROOMY.contextTokens));
    const [first, second] = budgetsFirst ? [saveBudgets, saveLlm] : [saveLlm, saveBudgets];
    const statuses = (await Promise.all([first(), second()])).map((res) => res.status);

    expect(statuses.toSorted()).toEqual([200, 400]);
    const saved = (await budgetSettings.read()).effective;
    expect(findInputOverflows(saved, currentWindows)).toEqual([]);
  });

  // 列に並べても、書くのに失敗した保存で、後ろの保存まで止めない
  it('still saves after a save that failed to write', async () => {
    const { app, budgetSettings } = makeApp();
    const write = budgetSettings.write;
    budgetSettings.write = () => Promise.reject(new Error('書けなかった'));
    expect((await put(app, '/settings/budgets', { candidates: { maxSize: 650 } })).status).toBe(
      500,
    );
    budgetSettings.write = write;

    expect((await put(app, '/settings/budgets', { candidates: { maxSize: 650 } })).status).toBe(
      200,
    );
    expect((await put(app, '/settings/llm', llmWith(ROOMY.contextTokens))).status).toBe(200);
  });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
