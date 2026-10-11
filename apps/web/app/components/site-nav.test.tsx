// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { SiteNav } from './site-nav';

afterEach(cleanup);

const hrefOf = (name: string) => screen.getByRole('link', { name }).getAttribute('href');

describe('SiteNav', () => {
  it('leads to every page, including the memory, from one bar', () => {
    render(
      <MemoryRouter>
        <SiteNav />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(hrefOf('会話')).toBe('/');
    expect(hrefOf('設定')).toBe('/settings');
    expect(hrefOf('手動で生成')).toBe('/generate');
    expect(hrefOf('依頼')).toBe('/jobs/new');
    expect(hrefOf('ジョブ')).toBe('/jobs');
    expect(hrefOf('記憶')).toBe('/memory');
    expect(hrefOf('許可')).toBe('/permissions');
    expect(hrefOf('候補の説明')).toBe('/candidates');
    expect(hrefOf('LLM の記録')).toBe('/llm-calls');
  });

  // 見出しが最初の項目の中にあると、読み上げで「描く 依頼」が1項目に聞こえ、組の区切りが伝わらない
  it('keeps each group heading outside of the items and names the group list after it', () => {
    render(
      <MemoryRouter>
        <SiteNav />
      </MemoryRouter>,
    );

    for (const [heading, first, last] of [
      ['描く', '依頼', '手動で生成'],
      ['覚えること', '記憶', '候補の説明'],
      ['設定', '設定', 'LLM の記録'],
    ] as const) {
      const group = screen.getByRole('list', { name: heading });
      const items = within(group).getAllByRole('listitem');
      expect(items[0]?.textContent).toBe(first);
      expect(items.at(-1)?.textContent).toBe(last);
    }
    expect(screen.getAllByRole('list')).toHaveLength(4);
  });

  it('marks the conversations as the current place on the list and on each conversation', () => {
    for (const path of ['/', '/conversations/20261009-153012-k3f9']) {
      render(
        <MemoryRouter initialEntries={[path]}>
          <SiteNav />
        </MemoryRouter>,
      );

      expect(screen.getByRole('link', { name: '会話' }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('link', { name: '設定' }).getAttribute('aria-current')).toBeNull();
      cleanup();
    }
  });

  it('opens the same destinations from the menu button, and closes once one is chosen', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <SiteNav />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));
    const drawer = screen.getByRole('dialog', { name: '行き先' });
    const inDrawer = within(drawer).getByRole('link', { name: '記憶' });
    expect(inDrawer.getAttribute('href')).toBe('/memory');

    await userEvent.click(inDrawer);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the menu on Escape and puts the focus back on the menu button', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <SiteNav />
      </MemoryRouter>,
    );
    const menu = screen.getByRole('button', { name: 'メニューを開く' });
    await userEvent.click(menu);
    expect(screen.getByRole('dialog', { name: '行き先' }).contains(document.activeElement)).toBe(
      true,
    );

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    // 閉じたすぐあとに確かめない: Radix は閉じた面の片づけの中から、タイマーで焦点を戻すため
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });
});
