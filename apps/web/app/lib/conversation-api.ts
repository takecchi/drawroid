import {
  conversationStreamUrl,
  interruptConversation,
  loadConversationEvents,
  postConversationMessage,
} from '@drawroid/swr';

import type { ConversationActions } from '../components/conversation-view';
import type { ConversationSource } from './conversation-stream';

/** 本物の購読元。再接続と Last-Event-ID はブラウザの EventSource に任せる */
export const apiConversationSource: ConversationSource = {
  loadEvents: (conversationId, after) => loadConversationEvents(conversationId, after),
  openStream: (conversationId, after) =>
    new EventSource(conversationStreamUrl(conversationId, after)),
};

/** 発言と止める。止めるボタンは scope: all（絵も含めて止める。設計書の「人間が止める」） */
export function apiConversationActions(conversationId: string): ConversationActions {
  return {
    send: async (text, clientMessageId) => {
      await postConversationMessage(conversationId, text, clientMessageId);
    },
    stop: () => interruptConversation(conversationId, 'all'),
  };
}
