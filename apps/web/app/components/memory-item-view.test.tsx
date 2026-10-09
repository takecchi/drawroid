// @vitest-environment jsdom
import { ApiError, type MemoryItemDetail } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryItemView } from './memory-item-view';

const mocks = vi.hoisted(() => ({
  saveMemoryItem: vi.fn(),
  deleteMemoryItem: vi.fn(),
  useMemoryItem: vi.fn(),
}));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  saveMemoryItem: mocks.saveMemoryItem,
  deleteMemoryItem: mocks.deleteMemoryItem,
  useMemoryItem: mocks.useMemoryItem,
}));

afterEach(cleanup);

const detail: MemoryItemDetail = {
  item: {
    id: 'm1',
    body: '指の崩れは許容しない',
    tags: ['hands'],
    scope: 'always',
    sources: ['job-1', 'job-gone'],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  },
  sources: [
    {
      kind: 'job',
      jobId: 'job-1',
      job: { kind: 'auto', createdAt: '2026-10-01T00:00:00.000Z', request: '猫の絵を描く' },
    },
    { kind: 'job', jobId: 'job-gone', job: null },
  ],
};

const reload = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useMemoryItem.mockReturnValue({ data: detail, error: undefined, mutate: reload });
});

function renderView() {
  render(
    <MemoryRouter initialEntries={['/memory/m1']}>
      <Routes>
        <Route path="/memory/:id" element={<MemoryItemView id="m1" />} />
        <Route path="/memory" element={<p>記憶の一覧の画面</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MemoryItemView editing', () => {
  it('saves the edited body, tags and scope with the updatedAt it opened', async () => {
    mocks.saveMemoryItem.mockResolvedValue({
      item: { ...detail.item, updatedAt: '2026-10-03T00:00:00.000Z' },
    });
    const user = userEvent.setup();
    renderView();

    const body = screen.getByLabelText('本文');
    await user.clear(body);
    await user.type(body, '手の崩れは許容しない');
    const tags = screen.getByLabelText(/tags/);
    await user.clear(tags);
    await user.type(tags, 'hands, anatomy');
    await user.selectOptions(screen.getByLabelText('scope'), 'tagged');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(mocks.saveMemoryItem).toHaveBeenCalledWith('m1', {
      body: '手の崩れは許容しない',
      tags: ['hands', 'anatomy'],
      scope: 'tagged',
      expectedUpdatedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('sends the updatedAt of the previous save on the next save', async () => {
    mocks.saveMemoryItem.mockResolvedValue({
      item: { ...detail.item, updatedAt: '2026-10-03T00:00:00.000Z' },
    });
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(mocks.saveMemoryItem).toHaveBeenLastCalledWith(
      'm1',
      expect.objectContaining({ expectedUpdatedAt: '2026-10-03T00:00:00.000Z' }),
    );
  });

  it('explains a conflict and reloads the latest item on request', async () => {
    mocks.saveMemoryItem.mockRejectedValue(new ApiError('conflict', '書き換えられた', 409));
    reload.mockResolvedValue({
      ...detail,
      item: {
        ...detail.item,
        body: 'ファイルで直された本文',
        updatedAt: '2026-10-04T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(
      await screen.findByText(/開いたあとにファイルが変わった。読み直してから直す/),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '読み直す' }));
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe(
      'ファイルで直された本文',
    );
    expect(screen.queryByText(/開いたあとにファイルが変わった/)).toBeNull();
  });

  it('shows the reason of a rejected save', async () => {
    mocks.saveMemoryItem.mockRejectedValue(new ApiError('invalid_request', '本文が長すぎる', 400));
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/本文が長すぎる/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '読み直す' })).toBeNull();
  });
});

describe('MemoryItemView deleting', () => {
  it('deletes after confirmation and moves to the list', async () => {
    mocks.deleteMemoryItem.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: '消す' }));
    expect(mocks.deleteMemoryItem).toHaveBeenCalledWith('m1');
    expect(await screen.findByText('記憶の一覧の画面')).toBeTruthy();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: '消す' }));
    expect(mocks.deleteMemoryItem).not.toHaveBeenCalled();
    expect(screen.queryByText('記憶の一覧の画面')).toBeNull();
  });
});

describe('MemoryItemView sources', () => {
  it('links each learned job to its page and marks a job that is gone', () => {
    renderView();
    const link = screen.getByRole('link', { name: 'job-1' });
    expect(link.getAttribute('href')).toBe('/jobs/job-1');
    expect(screen.getByText(/猫の絵を描く/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'job-gone' }).getAttribute('href')).toBe(
      '/jobs/job-gone',
    );
    expect(screen.getByText(/消えたジョブ/)).toBeTruthy();
  });

  it('links a conversation it learned from to that conversation, not to a job', () => {
    mocks.useMemoryItem.mockReturnValue({
      data: {
        item: { ...detail.item, sources: ['conversation:20261009-094204-2c158a', 'job-1'] },
        sources: [
          { kind: 'conversation', conversationId: '20261009-094204-2c158a' },
          detail.sources[0]!,
        ],
      },
      error: undefined,
      mutate: reload,
    });
    renderView();

    expect(screen.getByRole('link', { name: '20261009-094204-2c158a' }).getAttribute('href')).toBe(
      '/conversations/20261009-094204-2c158a',
    );
    expect(screen.getByRole('link', { name: 'job-1' }).getAttribute('href')).toBe('/jobs/job-1');
    expect(screen.queryByText(/消えたジョブ/)).toBeNull();
  });
});
