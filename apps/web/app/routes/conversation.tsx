import { useConversation } from '@drawroid/swr';
import { COMPOSER_FIELD_ID } from '@drawroid/ui';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

import { ConversationView } from '../components/conversation-view';
import type { SkipLinksHandle } from '../components/page-skip-links';
import { apiConversationActions, apiConversationSource } from '../lib/conversation-api';

// 会話はログが長くなり、発言欄はその後ろにある。ログを Tab で通り抜けずに発言欄へ行けるように
export const handle: SkipLinksHandle = {
  skipLinks: [{ targetId: COMPOSER_FIELD_ID, label: '発言欄へ移動' }],
};

export default function ConversationRoute() {
  const { conversationId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  // 「新しい会話」から来たときだけ、話しかける欄へフォーカスを移す。印は最初に読んだら手放す:
  // history に残すと、再読み込みや戻る・進むで開き直しただけでも欄へ移り、ほかの所を触っている人からフォーカスを奪うため
  const marked = (location.state as { focusComposer?: boolean } | null)?.focusComposer === true;
  // 会話ごとに1度だけ読む: 一覧から別の会話へ移っても、この画面は作り直されないので、最初に読んだ値を持ち越さないため。
  // 読んだ値は会話の間は覚えておく（印を手放したあとに欄が出ても移せるように）
  const [read, setRead] = useState({ conversationId, focusComposer: marked });
  const current =
    read.conversationId === conversationId ? read : { conversationId, focusComposer: marked };
  if (current !== read) setRead(current);
  const { focusComposer } = current;
  useEffect(() => {
    if (focusComposer) void navigate(location.pathname, { replace: true, state: null });
    // 会話ごとに最初の一度だけ
  }, [conversationId]);
  const { data } = useConversation(conversationId);
  const actions = useMemo(() => apiConversationActions(conversationId), [conversationId]);
  const title = data?.conversation.title;
  return (
    <ConversationView
      // 会話を移ったら画面ごと作り直す: 前の会話の下書きや送れなかった理由を、次の会話に持ち越さないため
      key={conversationId}
      conversationId={conversationId}
      focusComposer={focusComposer}
      source={apiConversationSource}
      actions={actions}
      title={
        <>
          <Link
            to="/"
            className="shrink-0 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground"
          >
            会話
          </Link>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="min-w-0 truncate font-medium">
            {title === undefined || title === '' ? '新しい会話' : title}
          </span>
        </>
      }
    />
  );
}
