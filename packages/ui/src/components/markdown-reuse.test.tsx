// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
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
import { STREAMING_REDRAW_MS } from './features/chat/use-throttled-text';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
    // 間引きの間隔を空けて増分を入れ、増分ごとに描き直させる
    vi.useFakeTimers();
    const { rerender } = render(view('流れて'));
    act(() => vi.advanceTimersByTime(STREAMING_REDRAW_MS));
    parses.count = 0;

    rerender(view('流れている'));
    act(() => vi.advanceTimersByTime(STREAMING_REDRAW_MS));
    rerender(view('流れている途中'));
    act(() => vi.advanceTimersByTime(STREAMING_REDRAW_MS));

    expect(parses.count).toBe(2);
  });
});
