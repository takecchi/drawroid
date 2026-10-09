import { z } from 'zod';

import { memoryItemSchema, memoryScopeSchema } from '../memory/item.js';
import type { MemoryStore } from '../memory/store.js';
import type { TalkTool } from './talk/tools.js';

/** 記憶の本文の長さ。長文の自由記述にしない（話す役・考える役に渡す量を予算で締めるため） */
const MAX_BODY_CHARS = 200;
const MAX_TAGS = 6;

const CONVERSATION_SOURCE_PREFIX = 'conversation:';

/** 会話から学んだ記憶の sources に入れる印。ジョブ ID と同じ形なので、見分けられるように前に付ける */
export function conversationSource(conversationId: string): string {
  return `${CONVERSATION_SOURCE_PREFIX}${conversationId}`;
}

/** sources の1つが会話から学んだ印なら、その会話 ID を返す。ジョブ ID なら undefined */
export function conversationOfSource(source: string): string | undefined {
  if (!source.startsWith(CONVERSATION_SOURCE_PREFIX)) return undefined;
  const conversationId = source.slice(CONVERSATION_SOURCE_PREFIX.length);
  return conversationId === '' ? undefined : conversationId;
}

const rememberInput = z
  .object({
    body: z.string().trim().min(1).max(MAX_BODY_CHARS).describe('覚える好みを短く'),
    scope: memoryScopeSchema.describe(
      'always はいつも効く好み、tagged は tags の語が依頼に出たときだけ効く好み',
    ),
    tags: z.array(z.string().trim().min(1).max(20)).max(MAX_TAGS).default([]),
  })
  .refine((input) => input.scope === 'always' || input.tags.length > 0, {
    message: 'tagged の好みには、効く語を tags に1つ以上書く',
    path: ['tags'],
  });

export type MemoryToolDeps = {
  memory: MemoryStore;
  now: () => Date;
  /** 記憶の ID（試験で差し替える） */
  newMemoryId?: () => string;
};

const defaultMemoryId = () => globalThis.crypto.randomUUID().slice(0, 8);

/** 会話から記憶に書くツール。記憶は会話をまたいで、別の会話の recall_memory から引ける */
export function createMemoryTools(deps: MemoryToolDeps): TalkTool[] {
  const remember: TalkTool = {
    name: 'remember',
    description:
      '人間の好みを記憶に書く。人間が「覚えておいて」と言ったときだけ呼ぶ。好みを短く書き、いつも効くなら always、特定の話題でだけ効くなら tagged と tags にする。',
    inputSchema: rememberInput,
    async run(raw, context) {
      const input = rememberInput.parse(raw);
      const at = deps.now().toISOString();
      const item = memoryItemSchema.parse({
        id: (deps.newMemoryId ?? defaultMemoryId)(),
        body: input.body,
        tags: input.tags,
        scope: input.scope,
        sources: [conversationSource(context.conversationId)],
        createdAt: at,
        updatedAt: at,
      });
      await deps.memory.put(item);
      const text = `覚えた（記憶 ${item.id}）: ${item.body}`;
      return { ok: true, result: text, summary: text };
    },
  };
  return [remember];
}
