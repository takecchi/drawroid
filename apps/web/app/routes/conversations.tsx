import { createConversation, isApiError, useConversations } from '@drawroid/swr';
import { Button, ConversationSummary, ErrorNote, Muted, Page, Section } from '@drawroid/ui';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { SetupNotice } from '../components/setup-notice';
import { formatTime } from '../lib/job-labels';

export default function Conversations() {
  const navigate = useNavigate();
  const { data, error } = useConversations();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  async function start() {
    setCreating(true);
    setCreateError(undefined);
    try {
      const conversation = await createConversation();
      await navigate(`/conversations/${conversation.conversationId}`);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setCreateError(caught.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Page
      title="会話"
      action={
        <Button variant="primary" disabled={creating} onClick={() => void start()}>
          新しい会話
        </Button>
      }
    >
      <SetupNotice />
      {createError !== undefined && <ErrorNote>会話を作れない: {createError}</ErrorNote>}
      {error !== undefined && <ErrorNote>一覧を読めない: {error.message}</ErrorNote>}
      <Section>
        {data !== undefined && data.conversations.length === 0 && (
          <Muted>
            まだ会話は無い。「新しい会話」から、描いてほしいものや聞きたいことを話しかける。
          </Muted>
        )}
        <ul className="divide-y divide-border">
          {data?.conversations.map((conversation) => (
            <li key={conversation.conversationId}>
              <Link
                to={`/conversations/${conversation.conversationId}`}
                className="-mx-2 block rounded-md px-2 py-3 hover:bg-muted"
              >
                <ConversationSummary
                  title={conversation.title === '' ? '新しい会話' : conversation.title}
                  preview={conversation.lastMessage}
                  running={conversation.running}
                  meta={formatTime(conversation.lastActiveAt)}
                />
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </Page>
  );
}
