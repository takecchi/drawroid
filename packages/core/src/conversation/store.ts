import { z } from 'zod';

import type { ConversationEvent, NewConversationEvent } from './events.js';

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
}
