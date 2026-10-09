// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageRow } from './features/chat/message';
import { STREAMING_REDRAW_MS } from './features/chat/use-throttled-text';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// 流れている途中で閉じていない形になるものを1つずつ含む返答
const REPLY = [
  '## 次の回の案',
  '',
  '**夕暮れの海辺**に立つ少女を、*逆光*で描きます。~~昼の空~~は使いません。',
  '',
  '- 髪は風になびかせる',
  '  - 毛先は細く',
  '1. 空は橙から紺へ',
  '- [ ] 指を直す',
  '',
  '> 前の回の評価: 指が崩れている',
  '',
  '| 回 | 点 | 直すこと |',
  '| :- | -: | :-: |',
  '| 1 | 0.62 | 指が崩れている |',
  '',
  '```json',
  '{ "prompt": "1girl, long hair, beach, sunset", "steps": 28 }',
  '```',
  '',
  '参考: [プロンプトの書き方](https://example.com/guide "題") と <https://example.com/auto>、[参照][g] と脚注[^1]。',
  '`inline code` と <span>生の HTML</span>、![外の画像](https://example.com/sea.png)。',
  '',
  '[g]: https://example.com/ref',
  '[^1]: 脚注の中身',
].join('\n');

// 途中の形では、閉じていない URL の頭（`h` など）が相対の link になることがある。危ないのは scheme の付いたものだけ
const UNSAFE_SCHEME = /^\s*(?!https?:|mailto:)[a-z][a-z0-9+.-]*:/i;

function expectSafe(root: HTMLElement) {
  expect(root.querySelector('script, iframe, img, span[class=""]')).toBeNull();
  for (const a of root.querySelectorAll('a')) {
    expect(a.getAttribute('href') ?? '').not.toMatch(UNSAFE_SCHEME);
  }
}

describe('a reply drawn while it streams', () => {
  it('draws every prefix, one character at a time, without throwing or warning, and stays safe', () => {
    // React の警告（key の重複・DOM の入れ子の誤りなど）も崩れとみなす
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // 描き直しは間引かれるので、増分ごとに間隔を進め、どの途中の形も実際に描かせる
    vi.useFakeTimers();
    const { container, rerender } = render(
      <MessageRow author="ai" streaming>
        {''}
      </MessageRow>,
    );
    for (let end = 1; end <= REPLY.length; end += 1) {
      rerender(
        <MessageRow author="ai" streaming>
          {REPLY.slice(0, end)}
        </MessageRow>,
      );
      act(() => vi.advanceTimersByTime(STREAMING_REDRAW_MS));
      expectSafe(container);
    }
    expect(errors).not.toHaveBeenCalled();
  });

  it('ends exactly as the finished reply is drawn from scratch', () => {
    const { container, rerender } = render(
      <MessageRow author="ai" streaming>
        {REPLY.slice(0, 40)}
      </MessageRow>,
    );
    rerender(
      <MessageRow author="ai" streaming>
        {REPLY.slice(0, 400)}
      </MessageRow>,
    );
    rerender(<MessageRow author="ai">{REPLY}</MessageRow>);
    const streamed = container.innerHTML;
    cleanup();

    const fresh = render(<MessageRow author="ai">{REPLY}</MessageRow>).container.innerHTML;
    // 脚注の id は描くたびに変わる（useId）ので、比べる前にそろえる
    const normalize = (html: string) => html.replace(/md_r_[0-9a-z]+_-/g, 'md-');
    expect(normalize(streamed)).toBe(normalize(fresh));
  });

  it('keeps an unclosed code block as code, and never shows its fence as text', () => {
    const { container } = render(
      <MessageRow author="ai" streaming>
        {'前置き\n\n```json\n{ "prompt": "1girl'}
      </MessageRow>,
    );

    expect(container.querySelector('pre code')?.textContent).toContain('{ "prompt": "1girl');
    expect(container.textContent).not.toContain('```');
  });

  it('does not make a link of a label whose URL is still being written, and does once it closes', () => {
    // 書きかけの URL の部分は、GFM の素の URL の自動の link になりうる（それ自体は崩れではない）
    const half = render(
      <MessageRow author="ai" streaming>
        {'[参考](https://exa'}
      </MessageRow>,
    ).container;
    expect([...half.querySelectorAll('a')].map((a) => a.textContent)).not.toContain('参考');
    expect(half.textContent).toContain('[参考](');
    cleanup();

    const closed = render(
      <MessageRow author="ai" streaming>
        {'[参考](https://example.com)'}
      </MessageRow>,
    ).container;
    const link = closed.querySelector('a');
    expect(link?.textContent).toBe('参考');
    expect(link?.getAttribute('href')).toBe('https://example.com');
  });
});
