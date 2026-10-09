import { DEFAULT_BUDGET, type StopConditionsDraft } from '@drawroid/core';
import type { ImageBackend, JobStore, ManualGenerationRunner, MemoryStore } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { createApi } from '../index.js';
import { LlmNotConfiguredError } from '../stop-condition-parse.js';

function makeApp(parse: (text: string) => Promise<StopConditionsDraft>) {
  return createApi({
    // 変換の経路はジョブとバックエンドを使わない
    backend: {} as ImageBackend,
    store: {} as JobStore,
    memoryStore: {} as MemoryStore,
    manualRunner: {} as ManualGenerationRunner,
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
    autoQueue: {
      kick: () => undefined,
      stop: async () => undefined,
      addInstruction: () => Promise.reject(new Error('この試験では使わない')),
      changeStopConditions: () => Promise.reject(new Error('この試験では使わない')),
      addReference: () => Promise.reject(new Error('この試験では使わない')),
      addMask: () => Promise.reject(new Error('この試験では使わない')),
    },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    stopConditionParser: { parse: (text) => parse(text) },
    env: {},
  });
}

const post = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.request('/stop-conditions/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /stop-conditions/parse', () => {
  it('answers 200 with the draft the parser produced', async () => {
    const draft: StopConditionsDraft = {
      ok: true,
      conditions: { aiJudgement: true, maxIterations: 10 },
      unparsed: ['夜まで'],
      warnings: [],
      clippedFrom: 400,
    };
    const res = await post(
      makeApp(async () => draft),
      { text: '10回か、AI が良いと思ったら' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draft });
  });

  it.each([
    ['empty', { text: '' }],
    ['blank', { text: '  ' }],
    ['missing', {}],
  ])('answers 400 when the text is %s, without calling the parser', async (_, body) => {
    let called = false;
    const res = await post(
      makeApp(async () => {
        called = true;
        throw new Error('呼ばれない');
      }),
      body,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_request' } });
    expect(called).toBe(false);
  });

  it('answers 409 llm_not_configured when no LLM is configured', async () => {
    const res = await post(
      makeApp(async () => {
        throw new LlmNotConfiguredError('LLM が未設定');
      }),
      { text: '5回' },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { kind: 'llm_not_configured', message: 'LLM が未設定' },
    });
  });

  it('answers 422 unparsable with the reason when the text could not be converted', async () => {
    const res = await post(
      makeApp(async () => ({ ok: false, reason: '構造化出力が検証に通らなかった' })),
      { text: '5回' },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { kind: 'unparsable', message: '構造化出力が検証に通らなかった' },
    });
  });
});
