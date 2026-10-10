// @vitest-environment jsdom
import { createConversation, useConversations } from '@drawroid/swr';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationRoute from './conversation';
import Conversations from './conversations';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  createConversation: vi.fn(),
  useConversations: vi.fn(),
}));
vi.mock('../components/setup-notice', () => ({ SetupNotice: () => null }));
// 会話の画面そのものは別の試験が見る。ここでは、話しかける欄へフォーカスを移して始めるかだけを見る
vi.mock('../components/conversation-view', () => ({
  ConversationView: ({ focusComposer }: { focusComposer?: boolean }) => (
    <p>発言欄へ移す: {String(focusComposer)}</p>
  ),
}));

/** いまの場所に付いた state（history に残るもの） */
function HistoryState() {
  return <output aria-label="history の state">{JSON.stringify(useLocation().state)}</output>;
}

function renderApp(initial: Parameters<typeof MemoryRouter>[0]['initialEntries']) {
  render(
    <MemoryRouter initialEntries={initial}>
      <Routes>
        <Route path="/" element={<Conversations />} />
        <Route path="/conversations/:conversationId" element={<ConversationRoute />} />
      </Routes>
      <HistoryState />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useConversations).mockReturnValue({
    data: { conversations: [] },
    error: undefined,
  } as never);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('starting a new conversation', () => {
  // 始めたばかりの会話では話しかける欄へ移す。移すという印は history から手放す（再読み込み・戻る進むで開き直しても移さない）
  it('starts the new conversation with the focus on the message field, and leaves no such mark in the history', async () => {
    vi.mocked(createConversation).mockResolvedValue({ conversationId: 'c-new' } as never);
    const user = userEvent.setup();
    renderApp(['/']);

    await user.click(screen.getByRole('button', { name: '新しい会話' }));

    expect(await screen.findByText('発言欄へ移す: true')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'history の state' }).textContent).toBe('null'),
    );
    expect(screen.getByText('発言欄へ移す: true')).toBeTruthy();
  });

  it('does not move the focus when an existing conversation is opened', () => {
    renderApp(['/conversations/c-1']);

    expect(screen.getByText('発言欄へ移す: false')).toBeTruthy();
  });
});
