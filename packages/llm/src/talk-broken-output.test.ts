// ローカル LLM がやりがちな崩れた出力に、話す役が耐えることを見る試験。本物の LLM の口（AiSdkLlm）と AI SDK の
// 試験用モデルで TalkRunner を回し、ツールを正しく呼ぶか、理由付きで error に閉じるか（黙って固まらない・
// 同じツールを繰り返し呼ばない）を、toolCalling: native と json の両方で見る
import {
  basicPermissions,
  ConversationHubs,
  createReadOnlyTools,
  DEFAULT_TALK_LIMITS,
  TalkRunner,
  type ConversationEvent,
  type JobStore,
  type Permissions,
  type TalkTool,
} from '@drawroid/core';
import { MemoryConversationStore, StubBackend } from '@drawroid/core/testing';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { AiSdkLlm } from './adapter.js';
import { roleConfigSchema } from './config.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const now = () => new Date('2026-10-09T09:00:00.000Z');
const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

/** 本文だけを流す応答 */
function textStream(text: string): StreamResult {
  const chunks: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
  return { stream: convertArrayToReadableStream(chunks) };
}

/** 本文を、いくつかの増分に分けて流す応答 */
function piecesStream(pieces: string[]): StreamResult {
  const chunks: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...pieces.map((delta): StreamPart => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
  return { stream: convertArrayToReadableStream(chunks) };
}

/** モデルのツール呼び出し（native）で返す応答。input は JSON の文字列のまま渡す（壊れた JSON も渡せる） */
function toolStream(name: string, input: string): StreamResult {
  const chunks: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'call-0', toolName: name, input },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
  return { stream: convertArrayToReadableStream(chunks) };
}

const permissions = {
  ...basicPermissions({ width: 1024, height: 1024 }),
  loras: { mode: 'auto' },
} as Permissions;

/** 「初音ミク描けますか？」を1ターン回し、確定したイベントと、search_candidates を実際に走らせた回数を返す */
async function talk(
  toolCalling: 'native' | 'json',
  replies: StreamResult[],
): Promise<{ events: ConversationEvent[]; searches: number }> {
  const store = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store, now });
  const { conversationId } = await store.createConversation(now());
  const model = new MockLanguageModelV4({ doStream: replies });
  const config = roleConfigSchema.parse({
    provider: 'local',
    model: 'qwen',
    toolCalling,
    structuredOutput: 'text',
  });
  const llm = new AiSdkLlm(
    { think: config, judge: config, talk: config },
    {
      think: { providerName: 'local', model },
      judge: { providerName: 'local', model },
      talk: { providerName: 'local', model },
    },
    { validationRetries: 2, networkRetries: 0 },
  );
  let searches = 0;
  const tools: TalkTool[] = createReadOnlyTools({
    backend: new StubBackend({ candidates: { lora: [{ name: 'miku_v2', label: '初音ミク' }] } }),
    permissions: async () => permissions,
    jobs: {} as JobStore,
  }).map((tool) =>
    tool.name === 'search_candidates'
      ? {
          ...tool,
          run: (input, context) => {
            searches += 1;
            return tool.run(input, context);
          },
        }
      : tool,
  );
  const runner = new TalkRunner({
    store,
    hubs,
    llm: () => llm,
    tools,
    limits: async () => DEFAULT_TALK_LIMITS,
    now,
  });
  await hubs
    .get(conversationId)
    .confirm({ type: 'user.message', text: '初音ミク描けますか？', attachments: [] });
  runner.kick(conversationId);
  await runner.idle(conversationId);
  return { events: (await store.readEvents(conversationId)).events, searches };
}

const REPLY = 'miku_v2 の LoRA があるので描けます。';
const SEARCH = { name: 'search_candidates', arguments: { kind: 'lora', query: 'ミク' } };
/** json の出し方で、そのまま受けられる正しい形 */
const jsonTool = (name: string, input: object) =>
  textStream(JSON.stringify({ kind: 'tool', name, input }));
const jsonReply = (text: string) => textStream(JSON.stringify({ kind: 'reply', text }));

const ended = (events: ConversationEvent[]) => events.at(-1);
const messages = (events: ConversationEvent[]) =>
  events.flatMap((e) => (e.type === 'assistant.message' ? [e.text] : []));
const toolCalls = (events: ConversationEvent[]) =>
  events.flatMap((e) => (e.type === 'tool.call' ? [{ name: e.name, input: e.input }] : []));

describe('a tool call written into the text instead of called', () => {
  const forms = {
    'in <tool_call> tags': `<tool_call>\n${JSON.stringify(SEARCH)}\n</tool_call>`,
    'in <tool_call> tags after a preface': `調べます。\n<tool_call>${JSON.stringify(SEARCH)}</tool_call>`,
    'in a json code block': `\`\`\`json\n${JSON.stringify(SEARCH)}\n\`\`\``,
    'as a bare JSON object': JSON.stringify(SEARCH),
  };

  for (const [form, written] of Object.entries(forms)) {
    it(`reads it and calls the tool, with native tool calling: ${form}`, async () => {
      const { events, searches } = await talk('native', [textStream(written), textStream(REPLY)]);

      expect(toolCalls(events)).toEqual([
        { name: 'search_candidates', input: { kind: 'lora', query: 'ミク' } },
      ]);
      expect(searches).toBe(1);
      // 書かれた呼び出しの文字は、返答として確定しない
      expect(messages(events).join('\n')).not.toMatch(/tool_call|"arguments"/);
      expect(messages(events)).toContain(REPLY);
      expect(ended(events)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
    });

    it(`reads it and calls the tool, with json tool calling: ${form}`, async () => {
      const { events, searches } = await talk('json', [textStream(written), jsonReply(REPLY)]);

      expect(toolCalls(events)).toEqual([
        { name: 'search_candidates', input: { kind: 'lora', query: 'ミク' } },
      ]);
      expect(searches).toBe(1);
      expect(messages(events)).toContain(REPLY);
      expect(ended(events)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
    });
  }

  it('keeps the preface written before the <tool_call> tags as the reply text (native)', async () => {
    const written = `調べます。\n<tool_call>${JSON.stringify(SEARCH)}</tool_call>`;
    const { events } = await talk('native', [textStream(written), textStream(REPLY)]);

    expect(messages(events)).toEqual(['調べます。', REPLY]);
  });

  it('leaves a JSON object in the reply alone when it names no tool it was given', async () => {
    const text = JSON.stringify({ name: 'miku', arguments: { style: 'anime' } });
    const { events } = await talk('native', [textStream(text)]);

    expect(toolCalls(events)).toEqual([]);
    expect(messages(events)).toEqual([text]);
    expect(ended(events)).toMatchObject({ outcome: 'done' });
  });

  it('leaves a tool call quoted inside a sentence alone, without tags', async () => {
    const text = `たとえば ${JSON.stringify(SEARCH)} のように調べられます。`;
    const { events, searches } = await talk('native', [textStream(text)]);

    expect(searches).toBe(0);
    expect(messages(events)).toEqual([text]);
    expect(ended(events)).toMatchObject({ outcome: 'done' });
  });
});

describe('arguments that are broken or do not fit', () => {
  for (const toolCalling of ['native', 'json'] as const) {
    const call = (input: string) =>
      toolCalling === 'native'
        ? toolStream('search_candidates', input)
        : textStream(`{"kind":"tool","name":"search_candidates","input":${input}}`);
    // 応答の流れは1度しか読めないので、試験ごとに作る
    const reply = () => (toolCalling === 'native' ? textStream(REPLY) : jsonReply(REPLY));

    it(`asks again when the JSON is broken, then calls the tool (${toolCalling})`, async () => {
      const { events, searches } = await talk(toolCalling, [
        call('{"kind":"lora","query":"ミク"'),
        call('{"kind":"lora","query":"ミク"}'),
        reply(),
      ]);

      expect(searches).toBe(1);
      expect(ended(events)).toMatchObject({ outcome: 'done' });
    });

    it(`ignores a field it does not know, and calls the tool (${toolCalling})`, async () => {
      const { events, searches } = await talk(toolCalling, [
        call('{"kind":"lora","query":"ミク","limit":5}'),
        reply(),
      ]);

      expect(searches).toBe(1);
      expect(toolCalls(events)[0]?.input).toEqual({ kind: 'lora', query: 'ミク' });
      expect(ended(events)).toMatchObject({ outcome: 'done' });
    });

    it(`closes the turn as an error, with the reason, when a field stays missing (${toolCalling})`, async () => {
      const missing = () => call('{"query":"ミク"}');
      const { events, searches } = await talk(toolCalling, [missing(), missing(), missing()]);

      expect(searches).toBe(0);
      expect(ended(events)).toMatchObject({
        outcome: 'error',
        reason: expect.stringMatching(/kind/),
      });
    });
  }
});

describe('a tool it was not given', () => {
  it('asks again, then closes the turn as an error naming the tool (native)', async () => {
    const unknown = () => toolStream('draw_now', '{}');
    const { events } = await talk('native', [unknown(), unknown(), unknown()]);

    expect(toolCalls(events)).toEqual([]);
    expect(ended(events)).toMatchObject({
      outcome: 'error',
      reason: expect.stringMatching(/draw_now/),
    });
  });

  it('asks again, then closes the turn as an error naming the tool (json)', async () => {
    const unknown = () => jsonTool('draw_now', {});
    const { events } = await talk('json', [unknown(), unknown(), unknown()]);

    expect(toolCalls(events)).toEqual([]);
    expect(ended(events)).toMatchObject({
      outcome: 'error',
      reason: expect.stringMatching(/draw_now/),
    });
  });

  it('calls the tool when it is asked again and gets the name right (native)', async () => {
    const { events, searches } = await talk('native', [
      toolStream('draw_now', '{}'),
      toolStream('search_candidates', JSON.stringify(SEARCH.arguments)),
      textStream(REPLY),
    ]);

    expect(searches).toBe(1);
    expect(ended(events)).toMatchObject({ outcome: 'done' });
  });
});

describe('thinking tags and empty text', () => {
  it('keeps the thinking out of the reply, with native tool calling', async () => {
    const { events } = await talk('native', [
      textStream(`<think>LoRA を探すべきか</think>${REPLY}`),
    ]);

    expect(messages(events)).toEqual([REPLY]);
    expect(events.find((e) => e.type === 'assistant.reasoning')).toMatchObject({
      text: 'LoRA を探すべきか',
    });
    expect(ended(events)).toMatchObject({ outcome: 'done' });
  });

  it('closes the turn as an error, saying the reply was empty, when the thinking never closes (native)', async () => {
    const { events } = await talk('native', [textStream('<think>LoRA を探すべきか、それとも')]);

    expect(messages(events)).toEqual([]);
    expect(ended(events)).toMatchObject({
      outcome: 'error',
      reason: expect.stringMatching(/空/),
    });
  });

  it('closes the turn as an error, with the reason, when the thinking never closes (json)', async () => {
    const unclosed = () => textStream('<think>LoRA を探すべきか、それとも');
    const { events } = await talk('json', [unclosed(), unclosed(), unclosed()]);

    expect(messages(events).join('')).not.toContain('<think>');
    expect(ended(events)).toMatchObject({ outcome: 'error', reason: expect.any(String) });
  });

  it('closes the turn as an error, saying the reply was empty, when nothing comes back (native)', async () => {
    const { events } = await talk('native', [textStream('')]);

    expect(ended(events)).toMatchObject({
      outcome: 'error',
      reason: expect.stringMatching(/空/),
    });
  });

  it('moves the thinking to the reasoning even when the tags are split across increments (native)', async () => {
    const { events } = await talk('native', [
      piecesStream(['<thi', 'nk>LoRA を', '探す</th', 'ink>\n\n', REPLY]),
    ]);

    expect(messages(events)).toEqual([REPLY]);
    expect(events.find((e) => e.type === 'assistant.reasoning')).toMatchObject({
      text: 'LoRA を探す',
    });
  });

  it('moves the text before a lone closing tag to the reasoning (native)', async () => {
    const { events } = await talk('native', [textStream(`LoRA を探すべきか</think>\n${REPLY}`)]);

    expect(messages(events)).toEqual([REPLY]);
    expect(events.find((e) => e.type === 'assistant.reasoning')).toMatchObject({
      text: 'LoRA を探すべきか',
    });
  });

  it('closes the turn as an error, saying the reply was empty, when only blank lines follow the thinking (native)', async () => {
    const { events } = await talk('native', [textStream('<think>考えた</think>\n\n')]);

    expect(messages(events)).toEqual([]);
    expect(ended(events)).toMatchObject({ outcome: 'error', reason: expect.stringMatching(/空/) });
  });
});
