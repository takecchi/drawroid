import { Page } from '@drawroid/ui';
import { Link, useParams } from 'react-router';

import { ConversationLlmCalls } from '../components/llm-call-view';

export default function ConversationLlmCallsRoute() {
  const { conversationId = '' } = useParams();
  return (
    <Page>
      <Link
        to={`/conversations/${conversationId}`}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        会話へ戻る
      </Link>
      <ConversationLlmCalls conversationId={conversationId} />
    </Page>
  );
}
