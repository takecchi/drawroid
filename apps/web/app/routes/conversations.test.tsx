// @vitest-environment jsdom
import { useConversations } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatTime } from '../lib/job-labels';
import Conversations from './conversations';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  useConversations: vi.fn(),
}));
// はじめの設定の案内は別の試験が見る。ここでは一覧だけを見る
vi.mock('../components/setup-notice', () => ({ SetupNotice: () => null }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('Conversations', () => {
  it('shows when something last happened in each conversation, not when it was started', () => {
    const createdAt = '2026-05-01T03:00:00.000Z';
    const lastActiveAt = '2026-10-09T12:34:00.000Z';
    vi.mocked(useConversations).mockReturnValue({
      data: {
        conversations: [
          {
            conversationId: 'c-1',
            title: '海辺の少女',
            createdAt,
            lastActiveAt,
            lastMessage: '続きを描いて',
            running: false,
          },
        ],
      },
      error: undefined,
    } as never);

    render(
      <MemoryRouter>
        <Conversations />
      </MemoryRouter>,
    );

    const row = screen.getByRole('link', { name: /海辺の少女/ });
    expect(row.textContent).toContain(formatTime(lastActiveAt));
    expect(row.textContent).not.toContain(formatTime(createdAt));
  });
});
