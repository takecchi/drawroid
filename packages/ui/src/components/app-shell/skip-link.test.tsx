// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatComposer } from '../features/chat';
import { COMPOSER_FIELD_ID, MAIN_CONTENT_ID, SkipLink } from './skip-link';

afterEach(cleanup);

describe('SkipLink', () => {
  it('is the first thing Tab reaches, and moves the focus to the main content without touching the URL', async () => {
    const before = window.location.href;
    render(
      <>
        <SkipLink />
        <nav>
          <a href="/jobs">ジョブ</a>
        </nav>
        <div id={MAIN_CONTENT_ID} tabIndex={-1}>
          本文
        </div>
      </>,
    );

    await userEvent.tab();
    const link = screen.getByRole('link', { name: '本文へ移動' });
    expect(document.activeElement).toBe(link);

    await userEvent.keyboard('{Enter}');

    expect(document.activeElement).toBe(document.getElementById(MAIN_CONTENT_ID));
    expect(window.location.href).toBe(before);
  });

  it('moves the focus to the place it names, such as the message field', async () => {
    render(
      <>
        <SkipLink />
        <SkipLink targetId={COMPOSER_FIELD_ID}>発言欄へ移動</SkipLink>
        <a href="/jobs">ジョブ</a>
        <textarea id={COMPOSER_FIELD_ID} aria-label="発言" />
      </>,
    );

    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: '発言欄へ移動' }));
    await userEvent.keyboard('{Enter}');

    expect(document.activeElement).toBe(screen.getByLabelText('発言'));
  });

  // 会話の発言欄が、「発言欄へ移動」の行き先になる
  it('takes the message field of a conversation as the place to move to', () => {
    render(<ChatComposer value="" onChange={() => undefined} onSend={() => undefined} />);

    expect(document.getElementById(COMPOSER_FIELD_ID)).toBe(screen.getByLabelText('発言'));
  });
});
