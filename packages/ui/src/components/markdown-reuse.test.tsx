// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock('mdast-util-from-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mdast-util-from-markdown')>();
  return {
    ...actual,
    fromMarkdown: ((...args: Parameters<typeof actual.fromMarkdown>) => {
      parses.count += 1;
      return actual.fromMarkdown(...args);
    }) as typeof actual.fromMarkdown,
  };
});

import { MessageRow } from './features/chat/message';

afterEach(cleanup);

describe('replies drawn again while another one streams', () => {
  it('parses only the streaming reply on each delta, not the settled ones', () => {
    // 会話の画面と同じく、増分のたびに行の要素を全部作り直す
    const view = (streaming: string) => (
      <div>
        {['**一つ目**の返答', '## 二つ目の返答', '- 三つ目の返答'].map((text) => (
          <MessageRow key={text} author="ai">
            {text}
          </MessageRow>
        ))}
        <MessageRow author="ai" streaming>
          {streaming}
        </MessageRow>
      </div>
    );
    const { rerender } = render(view('流れて'));
    parses.count = 0;

    rerender(view('流れている'));
    rerender(view('流れている途中'));

    expect(parses.count).toBe(2);
  });
});
