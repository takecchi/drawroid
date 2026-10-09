// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { MAIN_CONTENT_ID, SkipLink } from './skip-link';

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
});
