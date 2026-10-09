// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageRow } from './message';
import { STREAMING_REDRAW_MS } from './use-throttled-text';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const streaming = (text: string) => (
  <MessageRow author="ai" streaming>
    {text}
  </MessageRow>
);
const drawn = (container: HTMLElement) => container.querySelector('p')?.textContent ?? '';

describe('a streaming reply', () => {
  it('is drawn at most once per interval, and then with the last delta that arrived in it', () => {
    const { container, rerender } = render(streaming('夕'));
    expect(drawn(container)).toBe('夕');

    act(() => vi.advanceTimersByTime(10));
    rerender(streaming('夕暮'));
    act(() => vi.advanceTimersByTime(10));
    rerender(streaming('夕暮れ'));
    expect(drawn(container)).toBe('夕');

    act(() => vi.advanceTimersByTime(STREAMING_REDRAW_MS));
    expect(drawn(container)).toBe('夕暮れ');
  });

  it('does not leave its last characters undrawn when the deltas stop arriving', () => {
    const { container, rerender } = render(streaming('海'));
    for (const text of ['海辺', '海辺に', '海辺に立つ']) {
      act(() => vi.advanceTimersByTime(5));
      rerender(streaming(text));
    }

    act(() => vi.runOnlyPendingTimers());
    expect(drawn(container)).toBe('海辺に立つ');
  });

  it('draws at once, when it settles, exactly what drawing the finished reply from scratch draws', () => {
    const finished = '## 案\n\n**夕暮れ**の海辺に立つ少女。[参考](https://example.com)';
    const { container, rerender } = render(streaming(finished.slice(0, 5)));
    rerender(streaming(finished.slice(0, 20)));
    // 間隔を待たずに確定する
    rerender(<MessageRow author="ai">{finished}</MessageRow>);
    const settled = container.innerHTML;
    cleanup();

    const fresh = render(<MessageRow author="ai">{finished}</MessageRow>).container.innerHTML;
    expect(settled).toBe(fresh);
  });
});
