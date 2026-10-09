// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MessageRow } from './features/chat/message';
import { Markdown } from './markdown';

afterEach(cleanup);

const draw = (markdown: string) => render(<Markdown>{markdown}</Markdown>).container;

describe('Markdown', () => {
  it('draws headings, emphasis, lists and tables', () => {
    const root = draw(
      [
        '## 案',
        '',
        '**夕暮れ**の*海辺*',
        '',
        '- 長い髪',
        '- 白いワンピース',
        '',
        '| 回 | 点 |',
        '| - | - |',
        '| 1 | 0.8 |',
      ].join('\n'),
    );

    expect(root.querySelector('h2, h3, h4')?.textContent).toBe('案');
    expect(root.querySelector('strong')?.textContent).toBe('夕暮れ');
    expect(root.querySelectorAll('li')).toHaveLength(2);
    expect(root.querySelector('td')?.textContent).toBe('1');
  });

  it('shows raw HTML as text and never makes elements of it', () => {
    const root = draw(
      [
        '<script>alert(1)</script>',
        '',
        '前 <img src=x onerror="alert(2)"> 後',
        '',
        '<iframe src="https://example.com"></iframe>',
      ].join('\n'),
    );

    expect(root.querySelector('script, img, iframe')).toBeNull();
    expect(root.querySelector('[onerror]')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect(root.textContent).toContain('<img src=x onerror="alert(2)">');
  });

  it('does not make links of javascript: and other unsafe URLs, and keeps their words', () => {
    const root = draw(
      [
        '[押す](javascript:alert(1))',
        '',
        '[大文字](JaVaScRiPt:alert(2))',
        '',
        '[参照][x]',
        '',
        '[x]: javascript:alert(3)',
        '',
        '[データ](data:text/html,<script>alert(4)</script>)',
        '',
        '![画像](javascript:alert(5))',
      ].join('\n'),
    );

    for (const a of root.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|data):/i);
    }
    for (const img of root.querySelectorAll('img')) {
      expect(img.getAttribute('src') ?? '').not.toMatch(/^\s*(javascript|data):/i);
    }
    expect(root.querySelectorAll('a')).toHaveLength(0);
    expect(root.textContent).toContain('押す');
    expect(root.textContent).toContain('参照');
  });

  it('opens outside links in a new tab with rel="noopener noreferrer"', () => {
    draw('[参考](https://example.com/ref) と <https://example.com/auto>');

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('does not load outside images, and offers them as links instead', () => {
    const root = draw('![夕暮れの海](https://example.com/sea.png)');

    expect(root.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: '画像: 夕暮れの海' }).getAttribute('href')).toBe(
      'https://example.com/sea.png',
    );
  });

  it('keeps a code block on its own lines and lets it scroll sideways instead of wrapping', () => {
    const root = draw(
      [
        '```json',
        '{ "prompt": "girl, beach, sunset, very long line that must not wrap" }',
        '```',
      ].join('\n'),
    );

    const pre = root.querySelector('pre');
    expect(pre?.textContent).toContain('"prompt"');
    expect(pre?.className).toContain('overflow-x-auto');
    expect(pre?.className).toContain('whitespace-pre');
    expect(pre?.className).not.toContain('whitespace-pre-wrap');
  });
});

describe('MessageRow', () => {
  it('draws only the AI reply as Markdown, and leaves what the human typed as typed', () => {
    render(
      <>
        <MessageRow author="human">**人間の太字**</MessageRow>
        <MessageRow author="ai">**AI の太字**</MessageRow>
      </>,
    );

    expect(screen.getByText('**人間の太字**')).toBeTruthy();
    expect(screen.getByText('AI の太字').tagName).toBe('STRONG');
  });
});
