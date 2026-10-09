import { useConversations } from '@drawroid/swr';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';

import { ConversationView } from '../components/conversation-view';
import { apiConversationActions, apiConversationSource } from '../lib/conversation-api';

export default function ConversationRoute() {
  const { conversationId = '' } = useParams();
  const { data } = useConversations();
  const actions = useMemo(() => apiConversationActions(conversationId), [conversationId]);
  const title = data?.conversations.find((c) => c.conversationId === conversationId)?.title;
  return (
    <ConversationView
      // 会話を移ったら画面ごと作り直す: 前の会話の下書きや送れなかった理由を、次の会話に持ち越さないため
      key={conversationId}
      conversationId={conversationId}
      source={apiConversationSource}
      actions={actions}
      title={
        <>
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            会話
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="truncate font-medium">
            {title === undefined || title === '' ? '新しい会話' : title}
          </span>
        </>
      }
    />
  );
}
