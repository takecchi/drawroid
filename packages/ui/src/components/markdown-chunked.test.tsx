// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Markdown } from './markdown';

afterEach(cleanup);

// 段落をまたいで解釈が決まる Markdown。どれも、後ろの文字が来ると前の段落の描き方が変わりうる
const DOCUMENTS: Record<string, string> = {
  'a reference used before its definition': [
    '前の段落で [参照][g] と [省略形] を使う。',
    '',
    '間の段落。',
    '',
    '[g]: https://example.com/g "題"',
    '[省略形]: https://example.com/s',
    '',
    '後の段落。',
  ].join('\n'),
  'a definition placed before the paragraphs that use it': [
    '[g]: https://example.com/g',
    '',
    '[^n]: 先に置いた脚注',
    '',
    '後の段落で [参照][g] と脚注[^n] を使う。',
  ].join('\n'),
  'footnotes referred to across paragraphs': [
    '本文[^1] と [^b]。',
    '',
    '二つ目の段落[^1]。',
    '',
    '[^1]: 一つ目の脚注',
    '',
    '[^b]: 二つ目の脚注',
    '    続きの段落',
    '',
    '最後の段落。',
  ].join('\n'),
  'a list made loose by a blank line between its items': [
    '- 一',
    '- 二',
    '',
    '- 三',
    '',
    '  三の続きの段落',
    '',
    '後の段落',
    '',
    '3. 三から始まる',
    '4. 番号付き',
  ].join('\n'),
  'a code block holding blank lines, open until its fence closes': [
    '前の段落',
    '',
    '```py',
    'x = 1',
    '',
    '',
    'print(x)',
    '```',
    '',
    '後の段落',
  ].join('\n'),
  'a table that becomes one only when its delimiter row arrives': [
    '前の段落',
    '',
    '| 回 | 点 |',
    '| :- | -: |',
    '| 1 | 0.62 |',
    '',
    '後の段落',
  ].join('\n'),
  'raw HTML that runs across blank lines until its end tag': [
    '<!--',
    '',
    'コメントの中の段落',
    '',
    '-->',
    '',
    '<pre>',
    '',
    'pre の中',
    '',
    '</pre>',
    '',
    '後の段落',
  ].join('\n'),
  'raw HTML, indented code and quotes across blank lines': [
    '<div>',
    '',
    '**中**',
    '',
    '</div>',
    '',
    '段落',
    '',
    '    インデントのコード',
    '',
    '    続き',
    '',
    '> 引用',
    '',
    '> 二つ目の引用',
    '',
    '見出し',
    '===',
  ].join('\n'),
};

// 脚注の id の `useId` の部分は描くたびに変わるので、そろえて比べる
const normalize = (html: string) => html.replace(/md_r_[0-9a-z]+_-/g, 'md-');
const fresh = (markdown: string) => {
  const { container, unmount } = render(<Markdown>{markdown}</Markdown>);
  const html = normalize(container.innerHTML);
  unmount();
  return html;
};

describe('a reply drawn while it grows', () => {
  for (const [name, document] of Object.entries(DOCUMENTS)) {
    for (const step of [1, 7]) {
      it(`draws ${name} at every prefix exactly as drawing it from scratch (${step} at a time)`, () => {
        const { container, rerender } = render(<Markdown>{''}</Markdown>);
        const ends = [];
        for (let end = step; end < document.length; end += step) ends.push(end);
        ends.push(document.length);
        for (const end of ends) {
          const prefix = document.slice(0, end);
          rerender(<Markdown>{prefix}</Markdown>);
          expect(normalize(container.innerHTML), JSON.stringify(prefix)).toBe(fresh(prefix));
        }
      });
    }
  }

  it('draws a reply that jumps several paragraphs at once exactly as drawing it from scratch', () => {
    const document = Object.values(DOCUMENTS).join('\n\n');
    const { container, rerender } = render(<Markdown>{''}</Markdown>);
    for (const end of [10, 120, 121, 300, 450, document.length]) {
      const prefix = document.slice(0, end);
      rerender(<Markdown>{prefix}</Markdown>);
      expect(normalize(container.innerHTML), JSON.stringify(prefix)).toBe(fresh(prefix));
    }
  });

  it('draws a different reply after it from scratch, not on top of the one before', () => {
    const { container, rerender } = render(
      <Markdown>{DOCUMENTS['a list made loose by a blank line between its items']!}</Markdown>,
    );
    const other = DOCUMENTS['a reference used before its definition']!;
    rerender(<Markdown>{other}</Markdown>);
    expect(normalize(container.innerHTML)).toBe(fresh(other));
  });
});
