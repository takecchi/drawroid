// 話す役を、本物の LLM の口（AiSdkLlm）と AI SDK の試験用モデルで回し、会話の LLM 呼び出しの記録に
// 流れた思考が載り、文字数（chars）はその思考を数えないことを見る（docs の「思考は記録に載せる」の約束）
import {
  basicPermissions,
  ConversationHubs,
  createReadOnlyTools,
  DEFAULT_TALK_LIMITS,
  TalkRunner,
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

function thinkingStream(reasoning: string, text: string): StreamResult {
  const chunks: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'reasoning-start', id: 'r' },
    { type: 'reasoning-delta', id: 'r', delta: reasoning },
    { type: 'reasoning-end', id: 'r' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
  return { stream: convertArrayToReadableStream(chunks) };
}

const permissions = basicPermissions({ width: 1024, height: 1024 }) as Permissions;

async function talk(toolCalling: 'native' | 'json', replies: StreamResult[]) {
  const store = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store, now });
  const { conversationId } = await store.createConversation(now());
  const model = new MockLanguageModelV4({ doStream: replies });
  const config = roleConfigSchema.parse({
    provider: 'local',
    model: 'qwen',
    toolCalling,
    structuredOutput: 'json',
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
      backend: new StubBackend(),
      permissions: async () => permissions,
      jobs: {} as JobStore,
    }),
    limits: async () => DEFAULT_TALK_LIMITS,
    now,
  });
  await hubs
    .get(conversationId)
    .confirm({ type: 'user.message', text: '何ができますか？', attachments: [] });
  runner.kick(conversationId);
  await runner.idle(conversationId);
  return store.llmCalls.get(conversationId) ?? [];
}

describe('the conversation LLM call record of the talking role', () => {
  it.each(['native', 'json'] as const)(
    'carries the thinking the model streamed, with toolCalling: %s, and chars do not count it',
    async (toolCalling) => {
      const text =
        toolCalling === 'native' ? '絵を描けます。' : '{"kind":"reply","text":"絵を描けます。"}';
      const records = await talk(toolCalling, [thinkingStream('依頼を読んで答える', text)]);

      expect(records).toHaveLength(1);
      const [attempt] = records[0]?.attempts ?? [];
      expect(attempt?.reasoning).toBe('依頼を読んで答える');
      expect(attempt?.rawOutput).not.toContain('依頼を読んで答える');
      expect(records[0]?.chars.output).toBe(attempt?.rawOutput.length);
    },
  );
});
