// @vitest-environment jsdom
import { ApiError, type MemoryItemDetail } from '@drawroid/swr';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

describe('MemoryItemView headings', () => {
  // 画面の頭の見出し: この部品は記憶の1項目の画面にだけ置かれ、ほかに h1 が無いため。読み込み前・失敗のときも頭は在る。
  // 小見出しは h2: h1 の直下に置き、段を飛ばさない
  it('heads the page with 記憶の項目, and nests the sub headings right under it', () => {
    renderView();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('記憶の項目');
    expect(screen.getByRole('heading', { name: '学んだ元' }).tagName).toBe('H2');
    expect(screen.getByRole('heading', { name: '直す' }).tagName).toBe('H2');
    expect(screen.queryAllByRole('heading', { level: 3 })).toEqual([]);
  });

  it('keeps the heading of the page while the item is not read yet', () => {
    mocks.useMemoryItem.mockReturnValue({ data: undefined, error: undefined, mutate: reload });
    renderView();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('記憶の項目');
  });
});

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

  // 押した保存は送っている間押せなくなるので、断られたらフォーカスは断りへ移る。2回続けて断られても移る
  it('moves the focus to the reason when saving is refused, also on a second refusal', async () => {
    mocks.saveMemoryItem.mockRejectedValue(new ApiError('invalid_request', '本文が空', 400));
    const user = userEvent.setup();
    renderView();
    const save = () => screen.getByRole('button', { name: '保存' });

    save().focus();
    await user.keyboard('{Enter}');
    const first = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(first));

    save().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });

  // 保存すると押した保存は送っている間押せなくなり、フォーカスが body に落ちる。成功の知らせへ移す。2回続けても移す
  it('moves the focus to the note that it saved, also on a second save without editing', async () => {
    mocks.saveMemoryItem.mockResolvedValue({
      item: { ...detail.item, updatedAt: '2026-10-03T00:00:00.000Z' },
    });
    const user = userEvent.setup();
    renderView();
    const save = () => screen.getByRole('button', { name: '保存' });

    save().focus();
    await user.keyboard('{Enter}');
    const first = await screen.findByRole('status');
    expect(first.textContent).toMatch(/^保存した。/);
    await waitFor(() => expect(document.activeElement).toBe(first));

    save().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mocks.saveMemoryItem).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const note = screen.getByRole('status');
      expect(note).not.toBe(first);
      expect(document.activeElement).toBe(note);
    });
  });

  it('clears the note when a field is touched, and does not take the focus from the field', async () => {
    mocks.saveMemoryItem.mockResolvedValue({
      item: { ...detail.item, updatedAt: '2026-10-03T00:00:00.000Z' },
    });
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('status');

    const body = screen.getByLabelText('本文');
    await user.type(body, 'あ');
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.activeElement).toBe(body);
    await user.type(screen.getByLabelText(/tags/), 'x');
    expect(document.activeElement).toBe(screen.getByLabelText(/tags/));
  });

  it('clears the note when only the tags are touched, and keeps the focus in the tags', async () => {
    mocks.saveMemoryItem.mockResolvedValue({
      item: { ...detail.item, updatedAt: '2026-10-03T00:00:00.000Z' },
    });
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('status');

    const tags = screen.getByLabelText(/tags/);
    await user.type(tags, 'x');
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.activeElement).toBe(tags);
  });

  it('clears the note when only the scope is changed', async () => {
    mocks.saveMemoryItem.mockResolvedValue({
      item: { ...detail.item, updatedAt: '2026-10-03T00:00:00.000Z' },
    });
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('status');

    await user.selectOptions(screen.getByLabelText('scope'), 'tagged');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows no note when a refused save is followed by reloading the latest item', async () => {
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
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() =>
      expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe(
        'ファイルで直された本文',
      ),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  // 知らせが出たまま画面が描き直されても（読み直しで項目が届いたとき）、触っている欄からフォーカスを奪わない
  it('does not take the focus again when the view is drawn again while the note stays', async () => {
    mocks.saveMemoryItem.mockResolvedValue({
      item: { ...detail.item, updatedAt: '2026-10-03T00:00:00.000Z' },
    });
    const user = userEvent.setup();
    // 描き直すたびに新しい要素を渡す: 同じ要素を渡すと、React は描き直さない
    const tree = () => (
      <MemoryRouter initialEntries={['/memory/m1']}>
        <Routes>
          <Route path="/memory/:id" element={<MemoryItemView id="m1" />} />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(tree());
    await user.click(screen.getByRole('button', { name: '保存' }));
    const note = await screen.findByRole('status');
    await waitFor(() => expect(document.activeElement).toBe(note));

    const tags = screen.getByLabelText(/tags/);
    tags.focus();
    mocks.useMemoryItem.mockReturnValue({ data: { ...detail }, error: undefined, mutate: reload });
    rerender(tree());

    expect(screen.getByRole('status')).toBe(note);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement).toBe(tags);
  });

  it('shows no note when saving is refused', async () => {
    mocks.saveMemoryItem.mockRejectedValue(new ApiError('invalid_request', '本文が空', 400));
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('moves the focus to the explanation of a conflict', async () => {
    mocks.saveMemoryItem.mockRejectedValue(new ApiError('conflict', '書き換えられた', 409));
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: '保存' }));

    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
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

  it('names the kind of each learned job in Japanese, as the job list does', () => {
    mocks.useMemoryItem.mockReturnValue({
      data: {
        item: { ...detail.item, sources: ['job-1', 'job-2'] },
        sources: [
          detail.sources[0]!,
          {
            kind: 'job',
            jobId: 'job-2',
            job: { kind: 'manual', createdAt: '2026-10-01T00:00:00.000Z', request: 'a cat' },
          },
        ],
      },
      error: undefined,
      mutate: reload,
    });
    renderView();

    const [auto, manual] = screen.getAllByRole('listitem');
    expect(auto?.textContent).toMatch(/^job-1 自動 /);
    expect(manual?.textContent).toMatch(/^job-2 手動 /);
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
