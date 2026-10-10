import {
  buildJudgeInput,
  buildJudgeOutputSchema,
  buildThinkInput,
  buildThinkOutputSchema,
  createCarry,
  DEFAULT_BUDGET,
  DEFAULT_MODEL_WINDOW,
  THINK_PARAM_KEYS,
  type BudgetedMessages,
  type TalkStepPart,
} from '@drawroid/core';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiSdkLlm, extractJson } from './adapter.js';
import { roleConfigSchema, type RoleConfig } from './config.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

/** モデルが流す応答（ストリーム）。思考・本文・ツールの呼び出しを、この順に流す */
function streamOf(
  parts: {
    reasoning?: string;
    text?: string;
    toolCalls?: { name: string; input: string }[];
    finishReason?: 'stop' | 'length' | 'tool-calls';
    usage?: { input?: number; output?: number };
  } = {},
): StreamResult {
  const usage = parts.usage ?? { input: 100, output: 20 };
  const chunks: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (parts.reasoning !== undefined) {
    chunks.push(
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: parts.reasoning },
      { type: 'reasoning-end', id: 'r' },
    );
  }
  if (parts.text !== undefined) {
    chunks.push(
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: parts.text },
      { type: 'text-end', id: 't' },
    );
  }
  for (const [i, call] of (parts.toolCalls ?? []).entries()) {
    chunks.push({
      type: 'tool-call',
      toolCallId: `call-${i}`,
      toolName: call.name,
      input: call.input,
    });
  }
  const finishReason =
    parts.finishReason ?? (parts.toolCalls === undefined ? 'stop' : 'tool-calls');
  chunks.push({
    type: 'finish',
    finishReason: { unified: finishReason, raw: finishReason },
    usage: {
      inputTokens: {
        total: usage.input,
        noCache: usage.input,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
    },
  });
  return { stream: convertArrayToReadableStream(chunks) };
}

function reply(
  text: string,
  usage: { input?: number; output?: number } = { input: 100, output: 20 },
): StreamResult {
  return streamOf({ text, usage });
}

const role = (overrides: Partial<RoleConfig> = {}): RoleConfig =>
  roleConfigSchema.parse({ provider: 'local', model: 'qwen', ...overrides });

function adapter(model: MockLanguageModelV4, config: RoleConfig = role(), validationRetries = 2) {
  let clock = 0;
  return new AiSdkLlm(
    { think: config, judge: config, talk: config },
    {
      think: { providerName: 'local', model },
      judge: { providerName: 'local', model },
      talk: { providerName: 'local', model },
    },
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
  const prompt = model.doStreamCalls[index]?.prompt ?? [];
  return prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : [],
  );
}

/** 出力の上限で切れた応答 */
function cutAtLimit(text: string): StreamResult {
  return streamOf({ text, usage: { input: 100, output: 4096 }, finishReason: 'length' });
}

describe('AiSdkLlm.generateStructured when the output is cut at the limit', () => {
  const half = valid.slice(0, 30);

  it.each(['native', 'json', 'text'] as const)(
    'stops at once in %s mode, saying the limit of the LLM side cut it when drawroid sends none',
    async (structuredOutput) => {
      const model = new MockLanguageModelV4({ doStream: [cutAtLimit(half), reply(valid)] });
      const outcome = await adapter(model, role({ structuredOutput })).generateStructured(call());

      // 同じ上限で出し直しても同じ所で切れるので、出し直さない
      expect(model.doStreamCalls).toHaveLength(1);
      expect(model.doStreamCalls[0]?.maxOutputTokens).toBeUndefined();
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
    const model = new MockLanguageModelV4({ doStream: [cutAtLimit(half)] });
    const outcome = await adapter(model, role({ maxOutputTokens: 1024 })).generateStructured(
      call(),
    );

    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(1024);
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
      doStream: async () => {
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
    const model = new MockLanguageModelV4({ doStream: [cutAtLimit(half)] });
    const config = role({ maxOutputTokens: 1024 });
    const llm = new AiSdkLlm(
      { think: config, judge: config, talk: config },
      {
        think: { providerName: 'local', model },
        judge: { providerName: 'local', model },
        talk: { providerName: 'local', model },
      },
      {
        validationRetries: 2,
        networkRetries: 0,
        configKeys: { think: 'think', judge: 'think', talk: 'think' },
      },
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
    const model = new MockLanguageModelV4({ doStream: [reply(valid)] });
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
    const model = new MockLanguageModelV4({ doStream: [reply(broken), reply(valid)] });
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
      doStream: [reply('not json'), reply('{"params":{}}'), reply('still not json')],
    });
    await adapter(model).generateStructured(call());
    const lengths = [1, 2].map((i) => userTexts(model, i).join('').length);
    expect(Math.abs((lengths[1] ?? 0) - (lengths[0] ?? 0))).toBeLessThan(400);
    expect(userTexts(model, 2)).toHaveLength(2);
  });

  it('gives up with the reason after the retries are used up', async () => {
    const model = new MockLanguageModelV4({
      doStream: [reply('{}'), reply('{}'), reply('{}')],
    });
    const outcome = await adapter(model, role(), 2).generateStructured(call());
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toHaveLength(3);
    if (!outcome.ok) expect(outcome.reason).toMatch(/3 回続けてスキーマに合わなかった/);
  });

  it('reports unknown tokens when the provider does not return usage', async () => {
    const model = new MockLanguageModelV4({ doStream: [reply(valid, {})] });
    const outcome = await adapter(model).generateStructured(call());
    expect(outcome.attempts[0]?.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('returns a failure instead of throwing when the provider call fails', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
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
      doStream: async () => {
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
      doStream: async ({ abortSignal }) => {
        controller.abort();
        throw abortSignal?.reason ?? new Error('no signal');
      },
    });
    await expect(
      adapter(model).generateStructured(call({ signal: controller.signal })),
    ).rejects.toThrow();
  });

  it('sends the JSON Schema to the model in native mode', async () => {
    const model = new MockLanguageModelV4({ doStream: [reply(valid)] });
    await adapter(model, role({ structuredOutput: 'native' })).generateStructured(call());
    const format = model.doStreamCalls[0]?.responseFormat;
    expect(format?.type).toBe('json');
    expect(format && 'schema' in format && format.schema).toMatchObject({ type: 'object' });
  });

  it('puts the schema into the instructions and reads JSON out of text in text mode', async () => {
    const model = new MockLanguageModelV4({
      doStream: [reply(`はい。\n\`\`\`json\n${valid}\n\`\`\``)],
    });
    const outcome = await adapter(model, role({ structuredOutput: 'text' })).generateStructured(
      call(),
    );
    expect(outcome.ok).toBe(true);
    expect(model.doStreamCalls[0]?.responseFormat).toBeUndefined();
    const system = model.doStreamCalls[0]?.prompt.find((m) => m.role === 'system');
    expect(system?.content).toMatch(/JSON Schema/);
  });

  it('asks only for JSON in json mode', async () => {
    const model = new MockLanguageModelV4({ doStream: [reply(valid)] });
    await adapter(model, role({ structuredOutput: 'json' })).generateStructured(call());
    expect(model.doStreamCalls[0]?.responseFormat).toEqual({ type: 'json' });
  });

  it('passes images as image files and refuses them for a model without image input', async () => {
    const judgeMessages = buildJudgeInput({
      carry: createCarry('海辺', DEFAULT_BUDGET).carry,
      images: [
        {
          key: 'j/0001/0',
          data: new Uint8Array(
            await sharp({
              create: { width: 512, height: 512, channels: 3, background: '#c82828' },
            })
              .webp()
              .toBuffer(),
          ),
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

    const model = new MockLanguageModelV4({ doStream: [reply('{"ok":true}')] });
    await adapter(model).generateStructured(judgeCall);
    const files = model.doStreamCalls[0]?.prompt.flatMap((m) =>
      m.role === 'user' ? m.content.filter((p) => p.type === 'file') : [],
    );
    expect(files).toHaveLength(1);
    expect(files?.[0]).toMatchObject({ mediaType: 'image/jpeg' });

    const textOnly = new MockLanguageModelV4({ doStream: [reply('{"ok":true}')] });
    const outcome = await adapter(textOnly, role({ imageInput: false })).generateStructured(
      judgeCall,
    );
    expect(outcome.ok).toBe(false);
    expect(textOnly.doStreamCalls).toHaveLength(0);
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

describe('AiSdkLlm.generateStructured with reasoning', () => {
  it('passes the reasoning the model streams to onReasoning, returning the same value as before', async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamOf({ reasoning: '海辺なので逆光にする', text: valid })],
    });
    const thoughts: string[] = [];
    const outcome = await adapter(model).generateStructured(
      call({ onReasoning: (text) => thoughts.push(text) }),
    );

    expect(thoughts.join('')).toBe('海辺なので逆光にする');
    expect(outcome).toEqual({
      ok: true,
      value: { params: { prompt: 'girl, beach, sunset', steps: 28 }, rationale: '最初の案' },
      attempts: [
        {
          rawOutput: valid,
          usage: { inputTokens: 100, outputTokens: 20 },
          durationMs: 10,
          reasoning: '海辺なので逆光にする',
        },
      ],
    });
  });

  it('passes nothing to onReasoning when the role does not take reasoning', async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamOf({ reasoning: '考え', text: valid })],
    });
    const thoughts: string[] = [];
    const outcome = await adapter(model, role({ reasoning: 'none' })).generateStructured(
      call({ onReasoning: (text) => thoughts.push(text) }),
    );
    expect(outcome.ok).toBe(true);
    expect(thoughts).toEqual([]);
  });

  it('says to drop the thinking so far before each retry, and only when another try follows', async () => {
    const broken = (reasoning: string) => streamOf({ reasoning, text: '{"params":{}}' });
    const model = new MockLanguageModelV4({
      doStream: [
        broken('1回目の考え'),
        broken('2回目の考え'),
        streamOf({ reasoning: '3回目の考え', text: valid }),
      ],
    });
    const seen: string[] = [];
    const outcome = await adapter(model, role(), 2).generateStructured(
      call({ onReasoning: (text) => seen.push(text), onRetry: () => seen.push('<retry>') }),
    );

    expect(outcome.ok).toBe(true);
    expect(seen).toEqual(['1回目の考え', '<retry>', '2回目の考え', '<retry>', '3回目の考え']);
  });

  it('does not say to retry after the last try fails', async () => {
    const broken = () => streamOf({ reasoning: '考え', text: '{"params":{}}' });
    const model = new MockLanguageModelV4({ doStream: [broken(), broken()] });
    let retries = 0;
    const outcome = await adapter(model, role(), 1).generateStructured(
      call({ onRetry: () => (retries += 1) }),
    );

    expect(outcome.ok).toBe(false);
    expect(retries).toBe(1);
  });
});

const lookup = {
  name: 'search_candidates',
  description: '候補を調べる。描かない',
  inputSchema: z.object({ kind: z.enum(['lora', 'checkpoint']), query: z.string().min(1) }),
};
const stepCall = (overrides: Partial<Parameters<AiSdkLlm['streamStep']>[0]> = {}) => ({
  role: 'think' as const,
  messages: thinkMessages,
  tools: [lookup],
  signal: new AbortController().signal,
  ...overrides,
});

async function partsOf(iterable: AsyncIterable<TalkStepPart>): Promise<TalkStepPart[]> {
  const parts: TalkStepPart[] = [];
  for await (const part of iterable) parts.push(part);
  return parts;
}

describe('AiSdkLlm.streamStep', () => {
  it('maps the text, the reasoning and a validated tool call to step parts, with usage and time', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamOf({
          reasoning: 'キャラの LoRA があるか調べる',
          text: '調べます。',
          toolCalls: [{ name: 'search_candidates', input: '{"kind":"lora","query":"miku"}' }],
          usage: { input: 300, output: 40 },
        }),
      ],
    });
    const parts = await partsOf(adapter(model).streamStep(stepCall()));

    expect(parts).toEqual([
      { type: 'reasoning-delta', text: 'キャラの LoRA があるか調べる' },
      { type: 'text-delta', text: '調べます。' },
      {
        type: 'tool-call',
        // サーバの ID に、呼び出しごとの接頭辞が付く（ステップごとに同じ ID を返すサーバがあるため）
        callId: expect.stringMatching(/^native-[0-9a-f-]+-call-0$/),
        name: 'search_candidates',
        input: { kind: 'lora', query: 'miku' },
      },
      {
        type: 'finish',
        attempts: [
          {
            rawOutput:
              '調べます。\n[{"name":"search_candidates","input":{"kind":"lora","query":"miku"}}]',
            usage: { inputTokens: 300, outputTokens: 40 },
            durationMs: 10,
            reasoning: 'キャラの LoRA があるか調べる',
          },
        ],
      },
    ]);
    // ツールの定義（名前・説明・引数のスキーマ）を渡し、実行はさせない
    const tools = model.doStreamCalls[0]?.tools ?? [];
    expect(tools.map((t) => ('name' in t ? t.name : ''))).toEqual(['search_candidates']);
  });

  it('asks again with only a summary when the arguments do not match, and returns the call that does', async () => {
    const bad = '{"kind":"vae","query":""}';
    const model = new MockLanguageModelV4({
      doStream: [
        streamOf({ toolCalls: [{ name: 'search_candidates', input: bad }] }),
        streamOf({
          toolCalls: [{ name: 'search_candidates', input: '{"kind":"lora","query":"miku"}' }],
        }),
      ],
    });
    const parts = await partsOf(adapter(model).streamStep(stepCall()));

    expect(parts.map((p) => p.type)).toEqual(['retry', 'tool-call', 'finish']);
    expect(parts[0]).toMatchObject({ type: 'retry', reason: expect.stringContaining('kind') });
    const retryTexts = userTexts(model, 1);
    expect(retryTexts.some((t) => t.includes('受け付けられなかった') && t.includes('kind'))).toBe(
      true,
    );
    // 失敗した呼び出しの全文は積まない
    expect(retryTexts.some((t) => t.includes(bad))).toBe(false);
    const finish = parts.at(-1);
    expect(finish?.type === 'finish' && finish.failure).toBeUndefined();
    expect(finish?.type === 'finish' && finish.attempts[0]?.validationError).toMatch(/kind/);
  });

  it('fails the step when the arguments keep failing the schema', async () => {
    const wrong = () => streamOf({ toolCalls: [{ name: 'search_candidates', input: '{}' }] });
    const model = new MockLanguageModelV4({ doStream: [wrong(), wrong(), wrong()] });
    const parts = await partsOf(adapter(model, role(), 2).streamStep(stepCall()));

    expect(parts.map((p) => p.type)).toEqual(['retry', 'retry', 'finish']);
    const finish = parts.at(-1);
    expect(finish?.type === 'finish' && finish.failure).toMatch(/3 回続けてスキーマに合わなかった/);
    expect(finish?.type === 'finish' && finish.attempts).toHaveLength(3);
  });

  it('refuses a tool it was not given and arguments that are not JSON', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamOf({ toolCalls: [{ name: 'start_drawing', input: '{}' }] }),
        streamOf({ toolCalls: [{ name: 'search_candidates', input: '{kind:' }] }),
      ],
    });
    const parts = await partsOf(adapter(model, role(), 1).streamStep(stepCall()));
    expect(parts[0]).toMatchObject({
      type: 'retry',
      reason: expect.stringContaining('start_drawing'),
    });
    const finish = parts.at(-1);
    expect(finish?.type === 'finish' && finish.failure).toMatch(/JSON として読めない/);
  });

  it('stops a flowing call when the signal is aborted', async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(stream) {
            stream.enqueue({ type: 'stream-start', warnings: [] });
            stream.enqueue({ type: 'text-start', id: 't' });
            stream.enqueue({ type: 'text-delta', id: 't', delta: '描き' });
            abortSignal?.addEventListener('abort', () => stream.error(abortSignal.reason));
          },
        }),
      }),
    });
    const seen: TalkStepPart[] = [];
    await expect(
      (async () => {
        for await (const part of adapter(model).streamStep(
          stepCall({ signal: controller.signal }),
        )) {
          seen.push(part);
          if (part.type === 'text-delta') controller.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(seen.map((p) => p.type)).toEqual(['text-delta']);
  });

  it('fails the step, naming the setting, when the output is cut at the limit', async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamOf({ text: '描きま', finishReason: 'length' })],
    });
    const parts = await partsOf(
      adapter(model, role({ maxOutputTokens: 1024 })).streamStep(stepCall()),
    );
    const finish = parts.at(-1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(finish?.type === 'finish' && finish.failure).toContain('maxOutputTokens = 1024');
  });
});

/** 本文を何回かに分けて流す応答（部分的な JSON から本文を取り出すかを見るため） */
function streamInPieces(pieces: string[]): StreamResult {
  const chunks: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...pieces.map((delta): StreamPart => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
    },
  ];
  return { stream: convertArrayToReadableStream(chunks) };
}

describe('AiSdkLlm.streamStep with toolCalling: json', () => {
  const jsonRole = (structuredOutput: 'native' | 'json' | 'text') =>
    role({ toolCalling: 'json', structuredOutput });

  it('reads a tool call out of the structured output, without passing tools to the model', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamOf({
          text: 'はい。```json\n{"kind":"tool","name":"search_candidates","input":{"kind":"lora","query":"miku"}}\n```',
        }),
      ],
    });
    const parts = await partsOf(adapter(model, jsonRole('text')).streamStep(stepCall()));

    expect(parts.filter((p) => p.type !== 'finish')).toEqual([
      {
        type: 'tool-call',
        callId: expect.stringMatching(/^json-/),
        name: 'search_candidates',
        input: { kind: 'lora', query: 'miku' },
      },
    ]);
    expect(model.doStreamCalls[0]?.tools).toBeUndefined();
    // text の出し方では、ツールの説明ごとスキーマを指示文に載せる
    const system = model.doStreamCalls[0]?.prompt.find((m) => m.role === 'system');
    expect(String(system?.content)).toContain('候補を調べる。描かない');
  });

  it('streams the reply text out of the partial JSON, not the JSON itself', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamInPieces(['{"kind":"reply","te', 'xt":"描け', 'ます。LoRA', 'もあります"}']),
      ],
    });
    const parts = await partsOf(adapter(model, jsonRole('json')).streamStep(stepCall()));

    const texts = parts.flatMap((p) => (p.type === 'text-delta' ? [p.text] : []));
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.join('')).toBe('描けます。LoRAもあります');
    expect(texts.join('')).not.toContain('kind');
    expect(parts.at(-1)).toMatchObject({ type: 'finish' });
    expect(parts.at(-1)?.type === 'finish' && parts.at(-1)).not.toHaveProperty('failure');
  });

  it('sends the step schema in native structured output mode', async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamOf({ text: '{"kind":"reply","text":"はい"}' })],
    });
    await partsOf(adapter(model, jsonRole('native')).streamStep(stepCall()));
    const format = model.doStreamCalls[0]?.responseFormat;
    expect(format?.type).toBe('json');
    expect(JSON.stringify(format && 'schema' in format ? format.schema : {})).toContain(
      'search_candidates',
    );
  });

  it('asks again with only a summary, then gives the raw text and fails when the output keeps breaking', async () => {
    const broken = () =>
      streamOf({ text: '{"kind":"tool","name":"search_candidates","input":{"kind":"vae"}}' });
    const model = new MockLanguageModelV4({
      doStream: [broken(), broken(), streamOf({ text: '描けると思います' })],
    });
    const parts = await partsOf(adapter(model, jsonRole('text'), 2).streamStep(stepCall()));

    expect(parts.map((p) => p.type)).toEqual(['retry', 'retry', 'retry', 'text-delta', 'finish']);
    // 失敗した出力の全文は積まず、要約だけを足す
    expect(userTexts(model, 1).some((t) => t.includes('"kind":"vae"'))).toBe(false);
    expect(parts[3]).toEqual({ type: 'text-delta', text: '描けると思います' });
    const finish = parts.at(-1);
    expect(finish?.type === 'finish' && finish.failure).toMatch(/ツールを呼べなかった/);
    expect(parts.some((p) => p.type === 'tool-call')).toBe(false);
  });

  it('takes back the text it streamed when the confirmed reply says something else', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamInPieces([
          '{"kind":"reply","text":"下書き"}',
          '\n```json\n{"kind":"reply","text":"清書"}\n```',
        ]),
      ],
    });
    const parts = await partsOf(adapter(model, jsonRole('text')).streamStep(stepCall()));

    const streamed = parts.flatMap((p) => (p.type === 'text-delta' ? [p.text] : []));
    expect(streamed[0]).toBe('下書き');
    // 流した分は retry で捨てさせ、確定した本文だけを出し直す
    const retry = parts.findIndex((p) => p.type === 'retry');
    expect(retry).toBeGreaterThan(-1);
    expect(
      parts
        .slice(retry + 1)
        .flatMap((p) => (p.type === 'text-delta' ? [p.text] : []))
        .join(''),
    ).toBe('清書');
  });

  it('leaves the thinking tags out of the raw text it gives when the output keeps breaking', async () => {
    const broken = () =>
      streamOf({ text: '{"kind":"tool","name":"search_candidates","input":{"kind":"vae"}}' });
    const model = new MockLanguageModelV4({
      doStream: [
        broken(),
        broken(),
        streamOf({ text: '<think>どう答えるか</think>描けると思います' }),
      ],
    });
    const parts = await partsOf(adapter(model, jsonRole('text'), 2).streamStep(stepCall()));

    expect(parts.flatMap((p) => (p.type === 'text-delta' ? [p.text] : []))).toEqual([
      '描けると思います',
    ]);
  });
});

// 見る役が点数の低いまま「止めてよい」と返したら、出力の誤りとして、ほかの検証エラーと同じ回数だけ聞き直す
describe('AiSdkLlm.generateStructured with the judge schema', () => {
  const judgeCall = () => ({
    role: 'judge' as const,
    purpose: 'judge' as const,
    schema: buildJudgeOutputSchema(1),
    messages: buildJudgeInput({
      carry: createCarry('夕暮れの海辺の少女', DEFAULT_BUDGET).carry,
      images: [{ key: 'j/0001/0', data: new Uint8Array([1]), mediaType: 'image/png', longEdge: 1 }],
      budget: DEFAULT_BUDGET,
      window: DEFAULT_MODEL_WINDOW,
    }),
    signal: new AbortController().signal,
  });
  /** 2026-10-09 の実機（llama.cpp・Qwen2.5-VL-3B）で見る役が返した形 */
  const judged = (score: number, canStop: boolean) =>
    reply(
      JSON.stringify({
        images: [{ score, issues: ['海辺も少女も描かれていない'] }],
        nextChange: '海辺に立つ少女を描く',
        canStop,
      }),
    );

  it('asks again, naming canStop, when the judge says it can stop with a score of 0.49', async () => {
    const model = new MockLanguageModelV4({ doStream: [judged(0.49, true), judged(0.49, false)] });
    const outcome = await adapter(model).generateStructured(judgeCall());

    expect(outcome).toMatchObject({ ok: true, value: { canStop: false } });
    expect(outcome.attempts).toHaveLength(2);
    expect(userTexts(model, 1).some((t) => t.includes('canStop'))).toBe(true);
  });

  it('takes "can stop" at a score of 0.5 without asking again', async () => {
    const model = new MockLanguageModelV4({ doStream: [judged(0.5, true)] });
    const outcome = await adapter(model).generateStructured(judgeCall());

    expect(outcome).toMatchObject({ ok: true, value: { canStop: true } });
    expect(outcome.attempts).toHaveLength(1);
  });

  it('gives up after the same number of retries as any other schema error', async () => {
    const model = new MockLanguageModelV4({
      doStream: [judged(0, true), judged(0, true), judged(0, true), judged(0, false)],
    });
    const outcome = await adapter(model, role(), 2).generateStructured(judgeCall());

    expect(outcome.ok).toBe(false);
    expect(model.doStreamCalls).toHaveLength(3);
    if (!outcome.ok) expect(outcome.reason).toMatch(/3 回続けてスキーマに合わなかった.*canStop/);
  });
});

// 思考は、LLM 呼び出しの記録（attempts）にも載せる。試行ごとにその試行の思考だけを入れる
describe('attempts carry the reasoning of each attempt', () => {
  const broken = (reasoning?: string) =>
    streamOf({ ...(reasoning === undefined ? {} : { reasoning }), text: '{"params":{}}' });
  const wrongTool = (reasoning?: string) =>
    streamOf({
      ...(reasoning === undefined ? {} : { reasoning }),
      toolCalls: [{ name: 'search_candidates', input: '{}' }],
    });
  const goodTool = (parts: { reasoning?: string; text?: string } = {}) =>
    streamOf({
      ...parts,
      toolCalls: [{ name: 'search_candidates', input: '{"kind":"lora","query":"miku"}' }],
    });
  const brokenStep = (reasoning?: string) =>
    streamOf({
      ...(reasoning === undefined ? {} : { reasoning }),
      text: '{"kind":"tool","name":"search_candidates","input":{"kind":"vae"}}',
    });
  const reply = '{"kind":"reply","text":"はい"}';
  const jsonRole = (overrides: Partial<RoleConfig> = {}) =>
    role({ toolCalling: 'json', structuredOutput: 'json', ...overrides });
  const finishOf = (parts: TalkStepPart[]) => {
    const finish = parts.at(-1);
    if (finish?.type !== 'finish') throw new Error('finish がない');
    return finish;
  };
  const stepAttempts = async (doStream: StreamResult[], config: RoleConfig = role(), retries = 2) =>
    finishOf(
      await partsOf(
        adapter(new MockLanguageModelV4({ doStream }), config, retries).streamStep(stepCall()),
      ),
    ).attempts;

  it('generateStructured: puts only that attempt thinking on each attempt, failed ones too', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        broken('1回目の考え'),
        broken(),
        streamOf({ reasoning: '3回目の考え', text: valid }),
      ],
    });
    const outcome = await adapter(model, role(), 2).generateStructured(call());
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.attempts[0]?.reasoning).toBe('1回目の考え');
    expect(outcome.attempts[1]).not.toHaveProperty('reasoning');
    expect(outcome.attempts[2]?.reasoning).toBe('3回目の考え');
    expect(outcome.attempts[2]?.rawOutput).toBe(valid);
  });

  it('generateStructured: keeps the thinking out of rawOutput', async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamOf({ reasoning: '海辺なので逆光にする', text: valid })],
    });
    const outcome = await adapter(model).generateStructured(call());
    expect(outcome.attempts[0]?.reasoning).toBe('海辺なので逆光にする');
    expect(outcome.attempts[0]?.rawOutput).toBe(valid);
  });

  it('generateStructured: has no field when no thinking flowed, or the role is reasoning none', async () => {
    const plain = await adapter(
      new MockLanguageModelV4({ doStream: [streamOf({ text: valid })] }),
    ).generateStructured(call());
    expect(plain.attempts[0]).not.toHaveProperty('reasoning');
    const none = await adapter(
      new MockLanguageModelV4({ doStream: [streamOf({ reasoning: '考え', text: valid })] }),
      role({ reasoning: 'none' }),
    ).generateStructured(call());
    expect(none.attempts[0]).not.toHaveProperty('reasoning');
  });

  it('streamStepWithTools: puts the thinking on each attempt, failed one too, without carrying over', async () => {
    const attempts = await stepAttempts([
      wrongTool('1回目の考え'),
      goodTool({ reasoning: '2回目の考え' }),
    ]);
    expect(attempts.map((a) => a.reasoning)).toEqual(['1回目の考え', '2回目の考え']);
    expect(attempts[1]?.rawOutput).not.toContain('考え');
  });

  it('streamStepWithTools: includes the <think> text and the close-tag-only text, not in rawOutput', async () => {
    const [tagged] = await stepAttempts([
      goodTool({ text: '<think>タグの中の考え</think>調べます。' }),
    ]);
    expect(tagged?.reasoning).toBe('タグの中の考え');
    // rawOutput は今までどおり、モデルが返した本文そのまま（タグごと）。思考の欄を足したことで変えない
    expect(tagged?.rawOutput).toBe(
      '<think>タグの中の考え</think>調べます。\n[{"name":"search_candidates","input":{"kind":"lora","query":"miku"}}]',
    );
    const [closeOnly] = await stepAttempts([
      goodTool({ text: '閉じだけの考え</think>調べます。' }),
    ]);
    expect(closeOnly?.reasoning).toBe('閉じだけの考え');
  });

  it('streamStepWithTools: has no field without thinking or with reasoning none', async () => {
    const [plain] = await stepAttempts([goodTool()]);
    expect(plain).not.toHaveProperty('reasoning');
    const [none] = await stepAttempts(
      [goodTool({ reasoning: '考え', text: '<think>これも</think>調べます' })],
      role({ reasoning: 'none' }),
    );
    expect(none).not.toHaveProperty('reasoning');
  });

  it('streamStepAsJson: puts the streamed thinking on each attempt, failed ones too, without carrying over', async () => {
    const attempts = await stepAttempts(
      [
        brokenStep('1回目の考え'),
        brokenStep(),
        streamOf({ reasoning: '3回目の考え', text: reply }),
      ],
      jsonRole(),
    );
    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.reasoning).toBe('1回目の考え');
    expect(attempts[1]).not.toHaveProperty('reasoning');
    expect(attempts[2]?.reasoning).toBe('3回目の考え');
    expect(attempts[2]?.rawOutput).toBe(reply);
  });

  it('streamStepAsJson: has no field with reasoning none', async () => {
    const [none] = await stepAttempts(
      [streamOf({ reasoning: '考え', text: reply })],
      jsonRole({ reasoning: 'none' }),
    );
    expect(none).not.toHaveProperty('reasoning');
  });
});
