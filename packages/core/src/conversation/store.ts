import { z } from 'zod';

import type { REFERENCE_MEDIA_TYPES } from '../job/types.js';
import type { ConversationEvent, NewConversationEvent } from './events.js';

type ReferenceMediaType = (typeof REFERENCE_MEDIA_TYPES)[number];

/** 最初の発言から作る会話のタイトルの長さの上限 */
export const CONVERSATION_TITLE_CHARS = 40;

/**
 * 最初の発言から、会話のタイトルを決定的に作る。最初の空でない行を、上限の長さで切る。
 */
// LLM に付けさせない: タイトルのためだけに呼び出しを1回足し、トークンを払うことになるため
export function titleFromMessage(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  return line.length > CONVERSATION_TITLE_CHARS
    ? `${line.slice(0, CONVERSATION_TITLE_CHARS - 1)}…`
    : line;
}

/** conversation.json の中身 */
export const conversationSchema = z.object({
  conversationId: z.string().min(1),
  /** 最初の発言から決定的に作る。人間が直せる。まだ発言が無ければ空 */
  title: z.string().default(''),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Conversation = z.infer<typeof conversationSchema>;

/** 確定したイベントを after より後から読んだ1ページ */
export interface ConversationEventPage {
  events: ConversationEvent[];
  /** このページの最後の seq（1件も無ければ after のまま）。次のページはここから読む */
  last: number;
  /** まだ後ろに読んでいないイベントがあるか。黙って打ち切らないために返す */
  more: boolean;
}

/**
 * 会話の置き場所（conversations/<conversationId>/）。配置そのものを正とし、索引を持たない。
 */
export interface ConversationStore {
  createConversation(now: Date): Promise<Conversation>;
  /** conversation.json のある会話だけを返す。ディレクトリを消せば一覧から消える */
  listConversationIds(): Promise<string[]>;
  /** その会話があるか。形の違う ID には false を返す */
  hasConversation(conversationId: string): Promise<boolean>;
  readConversation(conversationId: string): Promise<Conversation>;
  /** タイトルを直す */
  writeConversation(conversation: Conversation): Promise<void>;
  /**
   * イベントを確定して置く。seq は置き場所が、欠けなく次の番号を振る。
   * 途中で失敗したら何も置かない（壊れた JSON も、番号の欠けも残らない）
   */
  appendEvent(
    conversationId: string,
    event: NewConversationEvent,
    now: Date,
  ): Promise<ConversationEvent>;
  /** after より後の確定したイベントを、seq の順に、最大 limit 件読む */
  readEvents(
    conversationId: string,
    options?: { after?: number; limit?: number },
  ): Promise<ConversationEventPage>;
  /** 会話で人間が添えた画像を置く（uploads/）。描き始めるときに、ジョブの参照画像（refs/）へ写す */
  addUpload(conversationId: string, upload: ConversationUpload, now: Date): Promise<string>;
  /** 添えた画像を読む。無ければ undefined */
  readUpload(conversationId: string, uploadId: string): Promise<ConversationUpload | undefined>;
}

/** 会話で人間が添えた画像1枚 */
export type ConversationUpload = {
  data: Uint8Array;
  mediaType: ReferenceMediaType;
};
