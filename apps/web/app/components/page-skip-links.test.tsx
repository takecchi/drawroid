// @vitest-environment jsdom
import { COMPOSER_FIELD_ID, MAIN_CONTENT_ID, SkipLink } from '@drawroid/ui';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { handle as conversationHandle } from '../routes/conversation';
import { PageSkipLinks } from './page-skip-links';

afterEach(cleanup);

/** root と同じ並び（本文へ移動・ページの飛び先・脇の行き先・本文）に、会話のページと設定のページを置く */
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            <SkipLink />
            <PageSkipLinks />
            <nav>
              <a href="/">会話</a>
              <a href="/settings">設定</a>
            </nav>
            <div id={MAIN_CONTENT_ID} tabIndex={-1}>
              <Outlet />
            </div>
          </>
        ),
        children: [
          {
            path: 'conversations/:conversationId',
            // 飛び先は、会話のページが本当に名乗るもの
            handle: conversationHandle,
            element: (
              <>
                <a href="/jobs/1">ジョブの詳細</a>
                <textarea id={COMPOSER_FIELD_ID} aria-label="発言" />
              </>
            ),
          },
          { path: 'settings', element: <p>設定</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}

describe('PageSkipLinks', () => {
  // ページの先頭から Tab 2 回で「発言欄へ移動」に届き、押すと発言欄へ移る（脇の行き先もログも通らない）
  it('offers moving to the message field right after moving to the main content, on a conversation', async () => {
    renderAt('/conversations/c-1');

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: '本文へ移動' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: '発言欄へ移動' }));
    await userEvent.keyboard('{Enter}');

    expect(document.activeElement).toBe(screen.getByLabelText('発言'));
  });

  // 発言欄の無いページには置かない（押しても動かない飛び先になるため）
  it('offers nothing more on a page without a message field', () => {
    renderAt('/settings');

    expect(screen.getByRole('link', { name: '本文へ移動' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '発言欄へ移動' })).toBeNull();
  });
});
