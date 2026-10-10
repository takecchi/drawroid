// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryList } from './memory-list';

const mocks = vi.hoisted(() => ({ useMemoryList: vi.fn() }));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  useMemoryList: mocks.useMemoryList,
}));

afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

describe('MemoryList', () => {
  it('shows each item with its scope, tags and the number of jobs it was learned from', () => {
    mocks.useMemoryList.mockReturnValue({
      data: {
        items: [
          {
            id: 'm1',
            body: '指の崩れは許容しない',
            tags: ['hands', 'anatomy'],
            scope: 'always',
            sources: ['a', 'b'],
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
          },
        ],
        invalid: [],
      },
      error: undefined,
    });
    render(
      <MemoryRouter>
        <MemoryList />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '指の崩れは許容しない' }).getAttribute('href')).toBe(
      '/memory/m1',
    );
    expect(screen.getByText(/\[always\]/)).toBeTruthy();
    expect(screen.getByText(/#hands #anatomy/)).toBeTruthy();
    expect(screen.getByText(/学んだ元 2件/)).toBeTruthy();
    expect(screen.queryByText('読めない項目')).toBeNull();
  });

  it('lists unreadable files apart from the items with their reason', () => {
    mocks.useMemoryList.mockReturnValue({
      data: { items: [], invalid: [{ id: 'broken', reason: 'front matter が無い' }] },
      error: undefined,
    });
    render(
      <MemoryRouter>
        <MemoryList />
      </MemoryRouter>,
    );
    expect(screen.getByText('まだ無い。')).toBeTruthy();
    // 画面の頭（h1）のすぐ下の段: h3 にすると、見出しを渡り歩くときに段が飛ぶため
    expect(screen.getByRole('heading', { level: 2, name: '読めない項目' })).toBeTruthy();
    expect(screen.getByText('broken')).toBeTruthy();
    expect(screen.getByText(/front matter が無い/)).toBeTruthy();
  });

  // ID と理由を別の行に分ける: 長い ID（名前の長すぎるファイル）が折り返すと、つなぎの「: 」が次の行の頭に1つだけ残るため
  it('puts the reason of an unreadable file on its own, apart from its name', () => {
    const longId = 'a'.repeat(235);
    mocks.useMemoryList.mockReturnValue({
      data: { items: [], invalid: [{ id: longId, reason: '名前を変える' }] },
      error: undefined,
    });
    render(
      <MemoryRouter>
        <MemoryList />
      </MemoryRouter>,
    );

    expect(screen.getByText(longId).tagName).toBe('CODE');
    expect(screen.getByText('名前を変える')).toBeTruthy();
  });

  // 空のままでは、覚える仕組みがあることも、いつ増えるのかも分からない
  it('says what comes in here and when, even while it is empty', () => {
    mocks.useMemoryList.mockReturnValue({ data: { items: [], invalid: [] }, error: undefined });
    render(
      <MemoryRouter>
        <MemoryList />
      </MemoryRouter>,
    );

    expect(screen.getByText('まだ無い。')).toBeTruthy();
    expect(
      screen.getByText(/描いたジョブが止まったときと、止まったあとに選び直したときに/),
    ).toBeTruthy();
  });

  // 記憶の画面の頭の見出しにする: この一覧は記憶の画面にだけ置かれ、ほかに h1 が無いため
  it('heads the page with 記憶', () => {
    mocks.useMemoryList.mockReturnValue({ data: { items: [], invalid: [] }, error: undefined });
    render(
      <MemoryRouter>
        <MemoryList />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('記憶');
  });
});
