// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
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
    expect(hrefOf('生成と設定')).toBe('/generate');
    expect(hrefOf('依頼')).toBe('/jobs/new');
    expect(hrefOf('ジョブ')).toBe('/jobs');
    expect(hrefOf('記憶')).toBe('/memory');
    expect(hrefOf('許可')).toBe('/permissions');
    expect(hrefOf('候補の説明')).toBe('/candidates');
    expect(hrefOf('LLM の記録')).toBe('/llm-calls');
  });

  it('marks the conversations as the current place on the list and on each conversation', () => {
    for (const path of ['/', '/conversations/20261009-153012-k3f9']) {
      render(
        <MemoryRouter initialEntries={[path]}>
          <SiteNav />
        </MemoryRouter>,
      );

      expect(screen.getByRole('link', { name: '会話' }).getAttribute('aria-current')).toBe('page');
      expect(
        screen.getByRole('link', { name: '生成と設定' }).getAttribute('aria-current'),
      ).toBeNull();
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
});
