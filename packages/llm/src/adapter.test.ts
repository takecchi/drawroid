import {
  buildJudgeInput,
  buildThinkInput,
  buildThinkOutputSchema,
  createCarry,
  DEFAULT_BUDGET,
  DEFAULT_MODEL_WINDOW,
  THINK_PARAM_KEYS,
  type BudgetedMessages,
} from '@drawroid/core';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiSdkLlm, extractJson } from './adapter.js';
import { roleConfigSchema, type RoleConfig } from './config.js';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function reply(
  text: string,
  usage: { input?: number; output?: number } = { input: 100, output: 20 },
): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: {
        total: usage.input,
        noCache: usage.input,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
    },
    warnings: [],
  };
}

const role = (overrides: Partial<RoleConfig> = {}): RoleConfig =>
  roleConfigSchema.parse({ provider: 'local', model: 'qwen', ...overrides });

function adapter(model: MockLanguageModelV4, config: RoleConfig = role(), validationRetries = 2) {
  let clock = 0;
  return new AiSdkLlm(
    { think: config, judge: config },
    { think: { providerName: 'local', model }, judge: { providerName: 'local', model } },
    { validationRetries, networkRetries: 0, now: () => (clock += 10) },
  );
}

const thinkMessages: BudgetedMessages = buildThinkInput({
  carry: createCarry('夕暮れの海辺の少女', DEFAULT_BUDGET).carry,
  progress: { iteration: 1 },
  allowed: THINK_PARAM_KEYS,
  budget: DEFAULT_BUDGET,
  window: DEFAULT_MODEL_WINDOW,
});
const thinkSchema = buildThinkOutputSchema({
  schema: z.object({ prompt: z.string(), steps: z.number().int().max(150) }),
  omitted: {},
});
const valid = JSON.stringify({
  params: { prompt: 'girl, beach, sunset', steps: 28 },
  rationale: '最初の案',
});
const call = (overrides: Partial<Parameters<AiSdkLlm['generateStructured']>[0]> = {}) => ({
  role: 'think' as const,
  purpose: 'think' as const,
  schema: thinkSchema,
  messages: thinkMessages,
  signal: new AbortController().signal,
  ...overrides,
});

function userTexts(model: MockLanguageModelV4, index: number): string[] {
  const prompt = model.doGenerateCalls[index]?.prompt ?? [];
  return prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : [],
  );
}

/** 出力の上限で切れた応答 */
function cutAtLimit(text: string): GenerateResult {
  return {
    ...reply(text, { input: 100, output: 4096 }),
    finishReason: { unified: 'length', raw: 'length' },
  };
}

describe('AiSdkLlm.generateStructured when the output is cut at the limit', () => {
  const half = valid.slice(0, 30);

  it.each(['native', 'json', 'text'] as const)(
    'stops at once in %s mode, saying the limit of the LLM side cut it when drawroid sends none',
    async (structuredOutput) => {
      const model = new MockLanguageModelV4({ doGenerate: [cutAtLimit(half), reply(valid)] });
      const outcome = await adapter(model, role({ structuredOutput })).generateStructured(call());

      // 同じ上限で出し直しても同じ所で切れるので、出し直さない
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(model.doGenerateCalls[0]?.maxOutputTokens).toBeUndefined();
      expect(outcome.ok).toBe(false);
      expect(outcome.attempts).toEqual([
        { rawOutput: half, usage: { inputTokens: 100, outputTokens: 4096 }, durationMs: 10 },
      ]);
      if (!outcome.ok) {
        expect(outcome.reason).toContain(
          '考える役の出力が、LLM 側の出力の上限で切れた（drawroid は出力の上限を送っていない）',
        );
        expect(outcome.reason).toContain('LLM のサーバかモデルの設定で');
        expect(outcome.reason).toContain('考える過程（reasoning）');
      }
    },
  );

  it('names the setting to raise, or to leave empty, when the role sets its own output limit', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [cutAtLimit(half)] });
    const outcome = await adapter(model, role({ maxOutputTokens: 1024 })).generateStructured(
      call(),
    );

    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(1024);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain(
        '考える役の出力が、出力の上限（maxOutputTokens = 1024）で切れた',
      );
      expect(outcome.reason).toContain(
        '「出力の上限（トークン）」（config.json の llm.roles.think.maxOutputTokens）を 2048 以上に上げるか、空にして LLM 側の設定に任せる',
      );
    }
  });

  it('treats a server error that says the output stopped at length the same way, keeping the original message', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error(
          'structured output was incomplete (finish_reason=length); increase the output budget',
        );
      },
    });
    const outcome = await adapter(model, role({ maxOutputTokens: 1024 })).generateStructured(
      call(),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain('llm.roles.think.maxOutputTokens）を 2048 以上に上げる');
      expect(outcome.reason).toContain(
        '元のエラー: structured output was incomplete (finish_reason=length)',
      );
    }
  });

  it('points at the settings of the think role when the judge role uses them', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [cutAtLimit(half)] });
    const config = role({ maxOutputTokens: 1024 });
    const llm = new AiSdkLlm(
      { think: config, judge: config },
      { think: { providerName: 'local', model }, judge: { providerName: 'local', model } },
      { validationRetries: 2, networkRetries: 0, configKeys: { think: 'think', judge: 'think' } },
    );
    const outcome = await llm.generateStructured(call({ role: 'judge' }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain(
        '見る役の出力が、出力の上限（maxOutputTokens = 1024）で切れた',
      );
      expect(outcome.reason).toContain(
        '見る役は考える役の設定を使っているので、LLM の設定の考える役の「出力の上限（トークン）」（config.json の llm.roles.think.maxOutputTokens）',
      );
    }
  });
});

describe('AiSdkLlm.generateStructured', () => {
  it('returns the validated value with tokens and time of the call', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [reply(valid)] });
    const outcome = await adapter(model).generateStructured(call());
    expect(outcome).toEqual({
      ok: true,
      value: { params: { prompt: 'girl, beach, sunset', steps: 28 }, rationale: '最初の案' },
      attempts: [
        { rawOutput: valid, usage: { inputTokens: 100, outputTokens: 20 }, durationMs: 10 },
      ],
    });
  });

  it('asks again with only a short summary of the error, then accepts a valid output', async () => {
    const broken = JSON.stringify({ params: { prompt: 'girl', steps: 999 }, rationale: 'x' });
    const model = new MockLanguageModelV4({ doGenerate: [reply(broken), reply(valid)] });
    const outcome = await adapter(model).generateStructured(call());

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]?.validationError).toMatch(/params\.steps/);
    const retryTexts = userTexts(model, 1);
    expect(retryTexts.some((t) => t.includes('params.steps'))).toBe(true);
    expect(retryTexts.some((t) => t.includes(broken))).toBe(false);
  });

  it('does not let the retry input grow with the number of retries', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [reply('not json'), reply('{"params":{}}'), reply('still not json')],
    });
    await adapter(model).generateStructured(call());
    const lengths = [1, 2].map((i) => userTexts(model, i).join('').length);
    expect(Math.abs((lengths[1] ?? 0) - (lengths[0] ?? 0))).toBeLessThan(400);
    expect(userTexts(model, 2)).toHaveLength(2);
  });

  it('gives up with the reason after the retries are used up', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [reply('{}'), reply('{}'), reply('{}')],
    });
    const outcome = await adapter(model, role(), 2).generateStructured(call());
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toHaveLength(3);
    if (!outcome.ok) expect(outcome.reason).toMatch(/3 回続けてスキーマに合わなかった/);
  });

  it('reports unknown tokens when the provider does not return usage', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [reply(valid, {})] });
    const outcome = await adapter(model).generateStructured(call());
    expect(outcome.attempts[0]?.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('returns a failure instead of throwing when the provider call fails', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      },
    });
    const outcome = await adapter(model).generateStructured(call());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/ECONNREFUSED/);
    expect(outcome.attempts).toHaveLength(1);
  });

  it('cuts a very long failure reason at 300 characters and ends it with an ellipsis', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('x'.repeat(2000));
      },
    });
    const outcome = await adapter(model).generateStructured(call());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe(`LLM の呼び出しに失敗した: ${'x'.repeat(300)}…`);
    }
  });

  it('throws when the call is aborted, so the job can stop as stopped by a human', async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        controller.abort();
        throw abortSignal?.reason ?? new Error('no signal');
      },
    });
    await expect(
      adapter(model).generateStructured(call({ signal: controller.signal })),
    ).rejects.toThrow();
  });

  it('sends the JSON Schema to the model in native mode', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [reply(valid)] });
    await adapter(model, role({ structuredOutput: 'native' })).generateStructured(call());
    const format = model.doGenerateCalls[0]?.responseFormat;
    expect(format?.type).toBe('json');
    expect(format && 'schema' in format && format.schema).toMatchObject({ type: 'object' });
  });

  it('puts the schema into the instructions and reads JSON out of text in text mode', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [reply(`はい。\n\`\`\`json\n${valid}\n\`\`\``)],
    });
    const outcome = await adapter(model, role({ structuredOutput: 'text' })).generateStructured(
      call(),
    );
    expect(outcome.ok).toBe(true);
    expect(model.doGenerateCalls[0]?.responseFormat).toBeUndefined();
    const system = model.doGenerateCalls[0]?.prompt.find((m) => m.role === 'system');
    expect(system?.content).toMatch(/JSON Schema/);
  });

  it('asks only for JSON in json mode', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [reply(valid)] });
    await adapter(model, role({ structuredOutput: 'json' })).generateStructured(call());
    expect(model.doGenerateCalls[0]?.responseFormat).toEqual({ type: 'json' });
  });

  it('passes images as image files and refuses them for a model without image input', async () => {
    const judgeMessages = buildJudgeInput({
      carry: createCarry('海辺', DEFAULT_BUDGET).carry,
      images: [
        {
          key: 'j/0001/0',
          data: new Uint8Array([1, 2, 3]),
          mediaType: 'image/webp',
          longEdge: 512,
        },
      ],
      budget: DEFAULT_BUDGET,
      window: DEFAULT_MODEL_WINDOW,
    });
    const judgeSchema = z.object({ ok: z.boolean() });
    const judgeCall = {
      ...call(),
      role: 'judge' as const,
      purpose: 'judge' as const,
      schema: judgeSchema,
      messages: judgeMessages,
    };

    const model = new MockLanguageModelV4({ doGenerate: [reply('{"ok":true}')] });
    await adapter(model).generateStructured(judgeCall);
    const files = model.doGenerateCalls[0]?.prompt.flatMap((m) =>
      m.role === 'user' ? m.content.filter((p) => p.type === 'file') : [],
    );
    expect(files).toHaveLength(1);
    expect(files?.[0]).toMatchObject({ mediaType: 'image/webp' });

    const textOnly = new MockLanguageModelV4({ doGenerate: [reply('{"ok":true}')] });
    const outcome = await adapter(textOnly, role({ imageInput: false })).generateStructured(
      judgeCall,
    );
    expect(outcome.ok).toBe(false);
    expect(textOnly.doGenerateCalls).toHaveLength(0);
  });
});

describe('extractJson', () => {
  it('reads an object wrapped in prose or a code block', () => {
    expect(extractJson('結果は {"a":1} です')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('reads the object in a code block even when the text before it contains a brace', () => {
    expect(extractJson('注意 {メモ}\n```json\n{"canStop":true}\n```')).toEqual({ canStop: true });
  });

  it('throws when there is no object', () => {
    expect(() => extractJson('わからない')).toThrow(SyntaxError);
  });

  // 思考を本文に <think>…</think> で混ぜるモデル（json・text の出し方で使うとき）。思考の中の { や
  // コードブロックを JSON として読まない
  it('skips the thinking in <think> tags, even when it contains braces', () => {
    expect(extractJson('<think>{"a":9} かな。いや {違う}</think>\n{"a":1}')).toEqual({ a: 1 });
  });

  it('skips a code block inside the thinking and reads the one after it', () => {
    expect(extractJson('<think>```json\n{"a":9}\n```</think>```json\n{"a":1}\n```')).toEqual({
      a: 1,
    });
  });

  it('skips the thinking when only the closing tag reaches the text', () => {
    // 開きタグをチャットのテンプレートが入れ、本文には閉じタグから後だけが来るモデル
    expect(extractJson('{"a":9} を考えた</think>\n{"a":1}')).toEqual({ a: 1 });
  });

  it('throws when the output ends inside the thinking', () => {
    // 出力の上限で思考の途中で切れたときは、思考の中の { を答えとして読まない
    expect(() => extractJson('<think>{"a":9} を考えて')).toThrow(SyntaxError);
  });
});

describe('describe', () => {
  it('tells the provider, model and window of each role', () => {
    const model = new MockLanguageModelV4();
    expect(adapter(model, role({ contextTokens: 4096 })).describe('judge')).toEqual({
      provider: 'local',
      model: 'qwen',
      window: { contextTokens: 4096, maxOutputTokens: 1024 },
      imageInput: true,
    });
  });

  it('reserves the configured output limit in the window', () => {
    const model = new MockLanguageModelV4();
    const window = adapter(model, role({ contextTokens: 4096, maxOutputTokens: 3000 })).describe(
      'think',
    ).window;
    expect(window).toEqual({ contextTokens: 4096, maxOutputTokens: 3000 });
  });
});
