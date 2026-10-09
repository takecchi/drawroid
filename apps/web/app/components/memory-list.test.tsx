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
    expect(screen.getByText('読めない項目')).toBeTruthy();
    expect(screen.getByText('broken')).toBeTruthy();
    expect(screen.getByText(/front matter が無い/)).toBeTruthy();
  });
});
