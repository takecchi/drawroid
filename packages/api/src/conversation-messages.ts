import { titleFromMessage, type ConversationEvent } from '@drawroid/core';

import type { ConversationsPort } from './deps.js';

export type IncomingMessage = {
  text: string;
  attachments?: { uploadId: string }[];
  clientMessageId?: string;
};

/**
 * 人間の発言を受けて、user.message を確定する。同じ clientMessageId の再送は二重に受けず、1回目の seq を返す。
 */
// 会話ごとに直列にする: 同じ ID の再送が同時に届いたとき、両方が「まだ無い」と見て2件確定しないように
export function createMessageIntake({ store, hubs, turns }: ConversationsPort) {
  const queues = new Map<string, Promise<unknown>>();
  /** 会話ごとの、受けた clientMessageId → seq。最初に使うときにイベントを読み通して作る */
  const seen = new Map<string, Map<string, number>>();

  async function seenOf(conversationId: string): Promise<Map<string, number>> {
    let ids = seen.get(conversationId);
    if (ids !== undefined) return ids;
    ids = new Map();
    let after = 0;
    for (;;) {
      const page = await store.readEvents(conversationId, { after });
      for (const event of page.events) {
        if (event.type === 'user.message' && event.clientMessageId !== undefined) {
          ids.set(event.clientMessageId, event.seq);
        }
      }
      after = page.last;
      if (!page.more) break;
    }
    seen.set(conversationId, ids);
    return ids;
  }

  async function accept(
    conversationId: string,
    message: IncomingMessage,
  ): Promise<{ seq: number; duplicate: boolean }> {
    const ids = await seenOf(conversationId);
    if (message.clientMessageId !== undefined) {
      const seq = ids.get(message.clientMessageId);
      if (seq !== undefined) return { seq, duplicate: true };
    }
    const confirmed: ConversationEvent = await hubs.get(conversationId).confirm({
      type: 'user.message',
      text: message.text,
      attachments: message.attachments ?? [],
      ...(message.clientMessageId !== undefined && { clientMessageId: message.clientMessageId }),
    });
    if (message.clientMessageId !== undefined) ids.set(message.clientMessageId, confirmed.seq);
    // 最初の発言でタイトルを決める。人間が先に直していれば、そのままにする
    const conversation = await store.readConversation(conversationId);
    if (conversation.title === '') {
      await store.writeConversation({ ...conversation, title: titleFromMessage(message.text) });
    }
    return { seq: confirmed.seq, duplicate: false };
  }

  return {
    post(conversationId: string, message: IncomingMessage) {
      const previous = queues.get(conversationId) ?? Promise.resolve();
      const run = previous.then(async () => {
        const accepted = await accept(conversationId, message);
        // 再送は二重にターンを始めない。確定してから知らせる: 実行器が読むイベントに、この発言が入っているように
        if (!accepted.duplicate) turns?.kick(conversationId);
        return accepted;
      });
      queues.set(
        conversationId,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}
