// @vitest-environment jsdom
import { createConversation, useConversation, useConversations } from '@drawroid/swr';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationRoute from './conversation';
import Conversations from './conversations';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  createConversation: vi.fn(),
  useConversation: vi.fn(),
  useConversations: vi.fn(),
}));
vi.mock('../components/setup-notice', () => ({ SetupNotice: () => null }));
// 会話の画面そのものは別の試験が見る。ここでは、話しかける欄へフォーカスを移して始めるかと、見出しのタイトルだけを見る
vi.mock('../components/conversation-view', () => ({
  ConversationView: ({ focusComposer, title }: { focusComposer?: boolean; title?: ReactNode }) => (
    <>
      <header>{title}</header>
      <p>発言欄へ移す: {String(focusComposer)}</p>
    </>
  ),
}));

/** いまの場所に付いた state（history に残るもの） */
function HistoryState() {
  return <output aria-label="history の state">{JSON.stringify(useLocation().state)}</output>;
}

/** 画面の外の道案内（一覧から別の会話を開く・ブラウザの戻る） */
function Navigation() {
  const navigate = useNavigate();
  return (
    <nav>
      <Link to="/conversations/c-2">別の会話</Link>
      <button type="button" onClick={() => void navigate(-1)}>
        戻る
      </button>
    </nav>
  );
}

function renderApp(initial: Parameters<typeof MemoryRouter>[0]['initialEntries']) {
  render(
    <MemoryRouter initialEntries={initial}>
      <Routes>
        <Route path="/" element={<Conversations />} />
        <Route path="/conversations/:conversationId" element={<ConversationRoute />} />
      </Routes>
      <HistoryState />
      <Navigation />
    </MemoryRouter>,
  );
}

/** 会話1つを読む口が返す形 */
const conversationOf = (conversationId: string, title: string) =>
  ({
    data: {
      conversation: { conversationId, title, createdAt: '2026-10-10T02:00:00.000Z' },
    },
    error: undefined,
  }) as never;

beforeEach(() => {
  vi.mocked(useConversations).mockReturnValue({
    data: { conversations: [] },
    error: undefined,
  } as never);
  vi.mocked(useConversation).mockImplementation((id) => conversationOf(id ?? '', ''));
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

  it('does not move the focus in another conversation opened right after starting a new one', async () => {
    vi.mocked(createConversation).mockResolvedValue({ conversationId: 'c-new' } as never);
    const user = userEvent.setup();
    renderApp(['/']);
    await user.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(await screen.findByText('発言欄へ移す: true')).toBeTruthy();

    await user.click(screen.getByRole('link', { name: '別の会話' }));

    expect(await screen.findByText('発言欄へ移す: false')).toBeTruthy();
  });

  // 印を付けた場所を history に残さない: 残すと、戻る・進むでそこへ戻ったときに、開き直しただけでも欄へ移るため
  it('goes back from a new conversation to where it was started, not to the new conversation with the mark', async () => {
    vi.mocked(createConversation).mockResolvedValue({ conversationId: 'c-new' } as never);
    const user = userEvent.setup();
    renderApp(['/']);
    await user.click(screen.getByRole('button', { name: '新しい会話' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'history の state' }).textContent).toBe('null'),
    );

    await user.click(screen.getByRole('button', { name: '戻る' }));

    expect(await screen.findByRole('button', { name: '新しい会話' })).toBeTruthy();
  });

  it('does not move the focus when an existing conversation is opened', () => {
    renderApp(['/conversations/c-1']);

    expect(screen.getByText('発言欄へ移す: false')).toBeTruthy();
  });
});

describe('the title of a conversation', () => {
  // 一覧を読まない: 一覧は全会話の要約で、会話が溜まるほど重く、会話の画面が数秒ごとに読み直すと開いている間ずっと払うため
  it('shows the title read from this conversation alone, not from the list of all conversations', () => {
    vi.mocked(useConversation).mockReturnValue(conversationOf('c-1', '海辺の少女を描いて'));

    renderApp(['/conversations/c-1']);

    expect(screen.getByText('海辺の少女を描いて')).toBeTruthy();
    expect(useConversation).toHaveBeenCalledWith('c-1');
    expect(useConversations).not.toHaveBeenCalled();
  });

  it('calls a conversation without a title yet a new conversation', () => {
    renderApp(['/conversations/c-1']);

    expect(screen.getByText('新しい会話')).toBeTruthy();
  });
});
