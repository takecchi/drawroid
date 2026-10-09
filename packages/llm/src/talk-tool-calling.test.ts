// 会話の話す役を、本物の LLM の口（AiSdkLlm）と AI SDK の試験用モデルで回し、ツールの呼び出し方（native / json）で
// 会話のイベントの列が変わらないことを見る（会話 J の受け入れ条件）
import {
  basicPermissions,
  ConversationHubs,
  createReadOnlyTools,
  DEFAULT_TALK_LIMITS,
  TalkRunner,
  type ConversationEvent,
  type JobStore,
  type Permissions,
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

function toolStream(name: string, input: object): StreamResult {
  const chunks: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'call-0', toolName: name, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
  return { stream: convertArrayToReadableStream(chunks) };
}

const permissions = {
  ...basicPermissions({ width: 1024, height: 1024 }),
  loras: { mode: 'auto' },
} as Permissions;

/** 「初音ミク描けますか？」を1ターン回し、確定したイベントを返す */
async function talk(
  toolCalling: 'native' | 'json',
  structuredOutput: 'native' | 'json' | 'text',
  replies: StreamResult[],
): Promise<ConversationEvent[]> {
  const store = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store, now });
  const { conversationId } = await store.createConversation(now());
  const model = new MockLanguageModelV4({ doStream: replies });
  const config = roleConfigSchema.parse({
    provider: 'local',
    model: 'qwen',
    toolCalling,
    structuredOutput,
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
  const runner = new TalkRunner({
    store,
    hubs,
    llm: () => llm,
    tools: createReadOnlyTools({
      backend: new StubBackend({ candidates: { lora: [{ name: 'miku_v2', label: '初音ミク' }] } }),
      permissions: async () => permissions,
      jobs: {} as JobStore,
    }),
    limits: async () => DEFAULT_TALK_LIMITS,
    now,
  });
  await hubs
    .get(conversationId)
    .confirm({ type: 'user.message', text: '初音ミク描けますか？', attachments: [] });
  runner.kick(conversationId);
  await runner.idle(conversationId);
  return (await store.readEvents(conversationId)).events;
}

/** 列として比べる形。時刻・seq・呼び出しの ID のような、出し方で変わる値は外す */
const shapeOf = (events: ConversationEvent[]) =>
  events.map((e) => {
    switch (e.type) {
      case 'tool.call':
        return { type: e.type, name: e.name, input: e.input };
      case 'tool.result':
        return { type: e.type, ok: e.ok, summary: e.summary };
      case 'assistant.message':
        return { type: e.type, text: e.text };
      case 'turn.ended':
        return { type: e.type, outcome: e.outcome };
      default:
        return { type: e.type };
    }
  });

describe('the talking role with toolCalling: json', () => {
  it('gives the same events with json and text as with native tool calling', async () => {
    const reply = 'miku_v2 の LoRA があるので描けます。';
    const native = await talk('native', 'native', [
      toolStream('search_candidates', { kind: 'lora', query: 'ミク' }),
      textStream(reply),
    ]);
    const json = await talk('json', 'text', [
      textStream(
        '```json\n{"kind":"tool","name":"search_candidates","input":{"kind":"lora","query":"ミク"}}\n```',
      ),
      textStream(JSON.stringify({ kind: 'reply', text: reply })),
    ]);

    expect(shapeOf(json)).toEqual(shapeOf(native));
    expect(shapeOf(native).map((e) => e.type)).toEqual([
      'user.message',
      'turn.started',
      'tool.call',
      'tool.result',
      'assistant.message',
      'turn.ended',
    ]);
  });

  it('gives the raw text and closes the turn as an error, calling no tool, when the output keeps breaking', async () => {
    const broken = () => textStream('{"kind":"tool","name":"start_drawing","input":{}}');
    const events = await talk('json', 'text', [broken(), broken(), textStream('描きますね！')]);

    expect(shapeOf(events)).toEqual([
      { type: 'user.message' },
      { type: 'turn.started' },
      { type: 'assistant.message', text: '描きますね！' },
      { type: 'turn.ended', outcome: 'error' },
    ]);
    expect(events.at(-1)).toMatchObject({
      reason: expect.stringContaining('ツールを呼べなかった'),
    });
    expect(events.some((e) => e.type === 'tool.call' || e.type === 'job.started')).toBe(false);
  });
});
