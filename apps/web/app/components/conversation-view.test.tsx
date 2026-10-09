// @vitest-environment jsdom
import { LLM_NOT_CONFIGURED_REASON, type ConversationEvent, type LiveEvent } from '@drawroid/core';
import { recheckBackendStatus, setSelection, useSelections } from '@drawroid/swr';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationSource, EventPage, StreamLike } from '../lib/conversation-stream';
import { ConversationView, type ConversationActions } from './conversation-view';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  recheckBackendStatus: vi.fn(),
  setSelection: vi.fn(),
  useSelections: vi.fn(),
}));

const JOB = '20261009-153112-k3f9';
const AT = '2026-10-09T15:30:00+09:00';

/** ブラウザの EventSource の代わり。試験から SSE のイベントを流す */
class FakeStream implements StreamLike {
  listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  closed = false;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(event: ConversationEvent | LiveEvent) {
    act(() => {
      for (const listener of this.listeners.get(event.type) ?? []) {
        listener(new MessageEvent(event.type, { data: JSON.stringify(event) }));
      }
    });
  }
}

function fakeSource(pages: EventPage[]) {
  const stream = new FakeStream();
  const opened: number[] = [];
  const loaded: number[] = [];
  const source: ConversationSource = {
    loadEvents: async (_id, after) => {
      loaded.push(after);
      return pages.shift() ?? { events: [], last: after, more: false };
    },
    openStream: (_id, after) => {
      opened.push(after);
      return stream;
    },
  };
  return { source, stream, opened, loaded };
}

let seq = 0;
function confirmed<E extends Omit<ConversationEvent, 'seq' | 'at'>>(event: E) {
  return { ...event, seq: ++seq, at: AT } as unknown as ConversationEvent;
}

const actions = (): ConversationActions & {
  send: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} => ({ send: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) });

function renderView(source: ConversationSource, given = actions()) {
  render(
    <MemoryRouter>
      <ConversationView conversationId="c1" source={source} actions={given} />
    </MemoryRouter>,
  );
  return { actions: given, user: userEvent.setup() };
}

beforeEach(() => {
  seq = 0;
  vi.mocked(useSelections).mockReturnValue({ data: { selections: [] } } as never);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('ConversationView', () => {
  it('draws the restored log once, after every page has been read', async () => {
    let releaseSecond: (page: EventPage) => void = () => {};
    const first = [confirmed({ type: 'user.message', text: '一つ目のページ', attachments: [] })];
    const pages: Promise<EventPage>[] = [
      Promise.resolve({ events: first, last: 1, more: true }),
      new Promise((resolve) => {
        releaseSecond = resolve;
      }),
    ];
    const source: ConversationSource = {
      loadEvents: () => pages.shift() ?? Promise.resolve({ events: [], last: 2, more: false }),
      openStream: () => new FakeStream(),
    };
    renderView(source);
    await act(async () => {});

    expect(screen.queryByText('一つ目のページ')).toBeNull();

    await act(async () => {
      releaseSecond({
        events: [confirmed({ type: 'user.message', text: '二つ目のページ', attachments: [] })],
        last: 2,
        more: false,
      });
    });
    expect(screen.getByText('一つ目のページ')).toBeTruthy();
    expect(screen.getByText('二つ目のページ')).toBeTruthy();
  });

  // 読み込む前から縦横の比で背を取る: 上の画像が遅れて読み込まれても、下で読んでいる行が押し下げられないように
  it('gives each image of a row the size the job asked for, so it holds its height before it loads', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(
      confirmed({
        type: 'job.images',
        jobId: JOB,
        iteration: 1,
        images: [{ index: 0, seed: 1 }],
        size: { width: 512, height: 768 },
      }),
    );

    const image = await screen.findByAltText('1 回目の画像 1 番（seed 1）');
    expect([image.getAttribute('width'), image.getAttribute('height')]).toEqual(['512', '768']);
  });

  it('does not draw the log rows again while a person types', async () => {
    const { source, stream } = fakeSource([]);
    const { user } = renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(
      confirmed({ type: 'job.images', jobId: JOB, iteration: 1, images: [{ index: 0, seed: 1 }] }),
    );
    const drawn = vi.mocked(useSelections).mock.calls.length;

    await user.type(screen.getByLabelText('発言'), 'もう少し');

    expect(vi.mocked(useSelections).mock.calls.length).toBe(drawn);
  });

  it('does not draw the confirmed rows again while a reply streams in', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(
      confirmed({ type: 'job.images', jobId: JOB, iteration: 1, images: [{ index: 0, seed: 1 }] }),
    );
    const drawn = vi.mocked(useSelections).mock.calls.length;

    await act(async () => {
      stream.emit({ type: 'delta.text', partId: 'm9', turn: 9, text: '流れて' });
      stream.emit({ type: 'delta.text', partId: 'm9', turn: 9, text: 'いる返答' });
    });

    expect(screen.getByText(/流れて/)).toBeTruthy();
    expect(vi.mocked(useSelections).mock.calls.length).toBe(drawn);
  });

  it('draws an image row again once its image is chosen or its job stops, even though the row itself did not change', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(
      confirmed({
        type: 'job.images',
        jobId: JOB,
        iteration: 1,
        images: [
          { index: 0, seed: 1 },
          { index: 1, seed: 2 },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^この画像で決める/ })).toHaveLength(2),
    );

    stream.emit(
      confirmed({
        type: 'job.adopted',
        jobId: JOB,
        iteration: 1,
        image: { iteration: 1, index: 0 },
      }),
    );
    await waitFor(() => expect(screen.getByText('この画像で決めた（選んだ）')).toBeTruthy());

    stream.emit(
      confirmed({
        type: 'job.stopped',
        jobId: JOB,
        reason: { kind: 'human', detail: '人が止めた' },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^この画像で決める/ })).toHaveProperty(
        'disabled',
        true,
      ),
    );
  });

  it('reads the backend again once when a job stops because the backend failed', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(
      confirmed({
        type: 'job.stopped',
        jobId: JOB,
        reason: { kind: 'error', detail: '生成の段: 繋がらない', backendErrorKind: 'unreachable' },
      }),
    );
    await waitFor(() => expect(screen.getByText(/描くのを止めた/)).toBeTruthy());
    // あとから届く発言や増分では、もう読み直さない
    stream.emit(confirmed({ type: 'user.message', text: 'まだ？', attachments: [] }));
    stream.emit({ type: 'delta.text', partId: 'm9', turn: 9, text: '確かめます' });
    await waitFor(() => expect(screen.getByText('確かめます')).toBeTruthy());

    expect(recheckBackendStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a person stopped it', { kind: 'human', detail: '人が止めた' }],
    ['it reached its limit', { kind: 'limit:iterations', detail: '3 回に達した' }],
    ['it failed outside the backend', { kind: 'error', detail: '見る段: 形が合わない' }],
  ])('does not read the backend again when a job stops because %s', async (_, reason) => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(confirmed({ type: 'job.stopped', jobId: JOB, reason }));
    await waitFor(() => expect(screen.getByText(/描くのを止めた|止めた|達した/)).toBeTruthy());

    expect(recheckBackendStatus).not.toHaveBeenCalled();
  });

  it('reads the selections of the job again when a person chose an image, so its button shows the favorite', async () => {
    const mutate = vi.fn();
    vi.mocked(useSelections).mockReturnValue({ data: { selections: [] }, mutate } as never);
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(
      confirmed({ type: 'job.images', jobId: JOB, iteration: 1, images: [{ index: 0, seed: 1 }] }),
    );
    expect(mutate).not.toHaveBeenCalled();

    stream.emit(
      confirmed({
        type: 'job.adopted',
        jobId: JOB,
        iteration: 1,
        image: { iteration: 1, index: 0 },
      }),
    );

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(vi.mocked(useSelections)).toHaveBeenLastCalledWith(JOB);
  });

  it('restores the log from every page of confirmed events, then subscribes after the last one', async () => {
    const first = [confirmed({ type: 'user.message', text: '描けますか？', attachments: [] })];
    const second = [
      confirmed({
        type: 'assistant.message',
        turn: 1,
        partId: 'm1',
        text: '描けます',
        interrupted: false,
      }),
    ];
    const { source, stream, opened, loaded } = fakeSource([
      { events: first, last: 1, more: true },
      { events: second, last: 2, more: false },
    ]);

    renderView(source);

    expect(await screen.findByText('描けます')).toBeTruthy();
    expect(screen.getByText('描けますか？')).toBeTruthy();
    expect(loaded).toEqual([0, 1]);
    expect(opened).toEqual([2]);

    // 走っている部品の写しから、続きが出る
    stream.emit({ type: 'delta.text', partId: 'm2', turn: 2, text: '続きの本文' });
    expect(screen.getByText('続きの本文')).toBeTruthy();
  });

  it('shows a row for each kind of streamed event', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(confirmed({ type: 'user.message', text: '海を描いて', attachments: [] }));
    stream.emit(
      confirmed({
        type: 'tool.call',
        turn: 1,
        callId: 'c1',
        name: 'start_drawing',
        input: { request: '海' },
      }),
    );
    stream.emit(
      confirmed({
        type: 'tool.result',
        turn: 1,
        callId: 'c1',
        ok: true,
        summary: 'ジョブを作った',
      }),
    );
    stream.emit(
      confirmed({
        type: 'job.started',
        jobId: JOB,
        request: '夕暮れの海',
        stopConditions: { aiJudgement: true, maxIterations: 3 },
      }),
    );
    stream.emit(
      confirmed({
        type: 'job.think',
        jobId: JOB,
        iteration: 1,
        rationale: '空を抑える',
        params: { steps: 28 },
        excluded: [],
      }),
    );
    stream.emit({
      type: 'generation.progress',
      jobId: JOB,
      iteration: 1,
      progress: 0.35,
      step: 7,
      steps: 20,
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('35');

    stream.emit(
      confirmed({ type: 'job.images', jobId: JOB, iteration: 1, images: [{ index: 0, seed: 7 }] }),
    );
    stream.emit(
      confirmed({
        type: 'job.judge',
        jobId: JOB,
        iteration: 1,
        images: [{ index: 0, score: 0.44999999999999996, issues: ['手が崩れている'] }],
        nextChange: '手を隠す',
        canStop: false,
      }),
    );
    stream.emit({ type: 'job.held', jobId: JOB, held: true });

    expect(screen.getByText('海を描いて')).toBeTruthy();
    expect(screen.getByText('ジョブを作った')).toBeTruthy();
    expect(screen.getByText('夕暮れの海')).toBeTruthy();
    expect(screen.getByText('空を抑える')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('score 0.45')).toBeTruthy();
    expect(screen.getByText('手が崩れている')).toBeTruthy();
    expect(screen.getByText('ちょっと違う。次は「手を隠す」。')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('話を聞いています');

    stream.emit(
      confirmed({
        type: 'job.stopped',
        jobId: JOB,
        reason: { kind: 'human', detail: '人間が止めた' },
      }),
    );
    expect(screen.getByText(/描くのを止めた/)).toBeTruthy();
  });

  it('announces thinking and listening in the same live region as the state changes', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    const region = screen.getByRole('status');

    stream.emit({ type: 'status', status: 'waiting-llm' });
    expect(region.textContent).toBe('考えています');

    stream.emit({ type: 'job.held', jobId: JOB, held: true });
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('話を聞いています（描くのは待たせています）');

    stream.emit({ type: 'job.held', jobId: JOB, held: false });
    expect(region.textContent).toBe('考えています');
  });

  it('says which image a human chose when the iteration was settled by the choice', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(
      confirmed({
        type: 'job.adopted',
        jobId: JOB,
        iteration: 2,
        image: { iteration: 2, index: 0 },
      }),
    );

    expect(
      screen.getByText('この回は、人間が選んだ画像（2 回目の画像 1 番）で決まり。'),
    ).toBeTruthy();
    expect(screen.getByText('見る役（2 回目）')).toBeTruthy();
  });

  it('keeps the reasoning open while it streams and folds it once confirmed', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit({
      type: 'delta.reasoning',
      partId: 'r1',
      source: { role: 'talk', turn: 1 },
      text: '質問なので',
    });
    expect((screen.getByText('質問なので').closest('details') as HTMLDetailsElement).open).toBe(
      true,
    );

    stream.emit(
      confirmed({
        type: 'assistant.reasoning',
        turn: 1,
        partId: 'r1',
        text: '質問なので、描かない',
      }),
    );

    expect(
      (screen.getByText('質問なので、描かない').closest('details') as HTMLDetailsElement).open,
    ).toBe(false);
  });

  it('shows the image in progress and fetches it again as the generation moves on', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    const progress = (step: number) => ({
      type: 'generation.progress' as const,
      jobId: JOB,
      iteration: 1,
      progress: step / 20,
      step,
      steps: 20,
      previewUrl: `/api/jobs/${JOB}/progress-preview`,
    });

    stream.emit(progress(4));
    const first = screen.getByRole('img', { name: '1 回目の途中の画像' }).getAttribute('src');
    stream.emit(progress(9));
    const later = screen.getByRole('img', { name: '1 回目の途中の画像' }).getAttribute('src');

    expect(first).toContain(`/api/jobs/${JOB}/progress-preview`);
    expect(later).toContain(`/api/jobs/${JOB}/progress-preview`);
    expect(later).not.toBe(first);
  });

  it('replaces the streamed text with the confirmed message of the same part', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit({ type: 'delta.text', partId: 'm1', turn: 1, text: 'これはちょっと' });
    stream.emit(
      confirmed({
        type: 'assistant.message',
        turn: 1,
        partId: 'm1',
        text: 'これはちょっと違いますね',
        interrupted: true,
      }),
    );

    expect(screen.queryByText('これはちょっと')).toBeNull();
    expect(screen.getByText('これはちょっと違いますね')).toBeTruthy();
    expect(screen.getByText('打ち切り')).toBeTruthy();
  });

  it('links each image row to the job detail and marks a favorite through the selections API', async () => {
    vi.mocked(setSelection).mockResolvedValue({} as never);
    const { source, stream } = fakeSource([]);
    const { user } = renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(
      confirmed({ type: 'job.images', jobId: JOB, iteration: 2, images: [{ index: 1, seed: 9 }] }),
    );

    expect(screen.getByRole('link', { name: 'ジョブの詳細' }).getAttribute('href')).toBe(
      `/jobs/${JOB}`,
    );
    expect(screen.getByAltText(/2 回目の画像 2 番/).getAttribute('src')).toBe(
      `/api/files/jobs/${JOB}/iterations/2/images/1.preview.webp`,
    );
    await user.click(screen.getByRole('button', { name: 'お気に入り: 2 回目の画像 2 番' }));
    expect(setSelection).toHaveBeenCalledWith(JOB, '2-1', 'favorite');

    await user.click(screen.getByRole('button', { name: '却下: 2 回目の画像 2 番' }));
    expect(setSelection).toHaveBeenCalledWith(JOB, '2-1', 'rejected');
  });

  it('shows the judge score and words in the large view, and chooses the image there through the same APIs', async () => {
    vi.mocked(setSelection).mockResolvedValue({} as never);
    const { source, stream } = fakeSource([]);
    const { user } = renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(
      confirmed({ type: 'job.images', jobId: JOB, iteration: 2, images: [{ index: 1, seed: 9 }] }),
    );
    stream.emit(
      confirmed({
        type: 'job.judge',
        jobId: JOB,
        iteration: 2,
        images: [{ index: 1, score: 0.82, issues: ['指が崩れている'] }],
        nextChange: '背景を明るく',
        canStop: false,
      }),
    );

    await user.click(screen.getByRole('button', { name: /^大きく見る: 2 回目の画像 2 番/ }));
    const dialog = within(screen.getByRole('dialog', { name: /2 回目の画像 2 番/ }));

    expect(dialog.getByText(/見る役の点 0\.82/)).toBeTruthy();
    expect(dialog.getByText('指が崩れている')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'お気に入り: 2 回目の画像 2 番' }));
    expect(setSelection).toHaveBeenCalledWith(JOB, '2-1', 'favorite');
    expect(
      dialog.getByRole('button', { name: 'この画像で決める: 2 回目の画像 2 番' }),
    ).toBeTruthy();
  });

  it('in the large view, does not let a stopped job be settled, and shows the chosen image as chosen', async () => {
    const { source, stream } = fakeSource([]);
    const { user } = renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(
      confirmed({
        type: 'job.images',
        jobId: JOB,
        iteration: 2,
        images: [
          { index: 0, seed: 8 },
          { index: 1, seed: 9 },
        ],
      }),
    );
    stream.emit(
      confirmed({
        type: 'job.adopted',
        jobId: JOB,
        iteration: 2,
        image: { iteration: 2, index: 0 },
      }),
    );
    stream.emit(
      confirmed({
        type: 'job.stopped',
        jobId: JOB,
        reason: { kind: 'adopted', detail: '人間が画像を選んだ' },
      }),
    );

    await user.click(screen.getByRole('button', { name: /^大きく見る: 2 回目の画像 2 番/ }));
    const second = within(screen.getByRole('dialog', { name: /2 回目の画像 2 番/ }));
    expect(
      second.getByRole('button', { name: 'この画像で決める: 2 回目の画像 2 番' }),
    ).toHaveProperty('disabled', true);
    expect(second.getByText('描くのはもう止まっているので、決められない')).toBeTruthy();

    await user.click(second.getByRole('button', { name: '前の画像' }));
    const first = within(screen.getByRole('dialog', { name: /2 回目の画像 1 番/ }));
    expect(first.getByText('この画像で決めた（選んだ）')).toBeTruthy();
  });

  it('names each image button after its image, so that they can be told apart when read aloud', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(
      confirmed({
        type: 'job.images',
        jobId: JOB,
        iteration: 1,
        images: [
          { index: 0, seed: 1 },
          { index: 1, seed: 2 },
        ],
      }),
    );

    expect(
      screen
        .getAllByRole('button', { name: /^お気に入り/ })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['お気に入り: 1 回目の画像 1 番', 'お気に入り: 1 回目の画像 2 番']);
    expect(screen.getByAltText('1 回目の画像 1 番（seed 1）')).toBeTruthy();
  });

  it('sends while the assistant is still replying, and stops through the actions', async () => {
    const { source, stream } = fakeSource([]);
    const { actions: given, user } = renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(confirmed({ type: 'turn.started', turn: 1, messageSeqs: [] }));
    stream.emit({ type: 'delta.text', partId: 'm1', turn: 1, text: 'チェック中です' });

    await user.type(screen.getByLabelText('発言'), 'これでいいから次はこうして{Enter}');
    await user.click(screen.getByRole('button', { name: '止める' }));

    expect(given.send).toHaveBeenCalledWith('これでいいから次はこうして', expect.any(String), []);
    expect(given.stop).toHaveBeenCalled();
    expect((screen.getByLabelText('発言') as HTMLTextAreaElement).value).toBe('');
  });

  describe('attaching images', () => {
    beforeEach(() => {
      // jsdom は object URL を持たない
      vi.stubGlobal(
        'URL',
        Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    const png = (name: string) =>
      new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

    it('uploads each attached image first, then sends their IDs with the message, and clears them', async () => {
      const { source, stream } = fakeSource([]);
      const given = {
        ...actions(),
        upload: vi.fn().mockResolvedValueOnce('u-1').mockResolvedValueOnce('u-2'),
      };
      const { user } = renderView(source, given);
      await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

      await user.upload(screen.getByLabelText('添える画像を選ぶ'), [
        png('beach.png'),
        png('sky.png'),
      ]);
      const list = screen.getByRole('list', { name: '添える画像' });
      expect(
        within(list)
          .getAllByRole('img')
          .map((img) => img.getAttribute('alt')),
      ).toEqual(['beach.png', 'sky.png']);
      await user.type(screen.getByLabelText('発言'), 'この2枚で描いて{Enter}');

      expect(given.upload).toHaveBeenCalledTimes(2);
      expect(given.upload.mock.calls[0]![0]).toMatchObject({ mediaType: 'image/png' });
      expect(given.send).toHaveBeenCalledWith('この2枚で描いて', expect.any(String), [
        { uploadId: 'u-1' },
        { uploadId: 'u-2' },
      ]);
      await waitFor(() => expect(screen.queryByRole('list', { name: '添える画像' })).toBeNull());
    });

    it('takes an attached image off by its name, and refuses what is not an image, saying why', async () => {
      const { source, stream } = fakeSource([]);
      const given = { ...actions(), upload: vi.fn().mockResolvedValue('u-1') };
      const { user } = renderView(source, given);
      await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

      await user.upload(screen.getByLabelText('添える画像を選ぶ'), [
        png('beach.png'),
        png('sky.png'),
      ]);
      await user.click(screen.getByRole('button', { name: 'beach.png を外す' }));
      // 選ぶ口の accept を外して選ばれた場合（user.upload は accept に合わないファイルを渡さないので、直に渡す）
      fireEvent.change(screen.getByLabelText('添える画像を選ぶ'), {
        target: { files: [new File(['x'], 'note.txt', { type: 'text/plain' })] },
      });
      await user.type(screen.getByLabelText('発言'), '描いて{Enter}');

      expect(screen.getByText(/添えられない: note.txt/)).toBeTruthy();
      expect(given.upload).toHaveBeenCalledTimes(1);
      expect(given.send).toHaveBeenCalledWith('描いて', expect.any(String), [{ uploadId: 'u-1' }]);
    });

    it('shows no way to attach when the actions cannot upload', async () => {
      const { source, stream } = fakeSource([]);
      renderView(source);
      await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

      expect(screen.queryByRole('button', { name: '画像を添える' })).toBeNull();
    });

    it('says how many images a message carried', async () => {
      const { source } = fakeSource([
        {
          events: [
            confirmed({
              type: 'user.message',
              text: 'この2枚で描いて',
              attachments: [{ uploadId: 'u-1' }, { uploadId: 'u-2' }],
            }),
          ],
          last: 1,
          more: false,
        },
      ]);
      renderView(source);

      expect(await screen.findByText('画像を 2 枚添えた')).toBeTruthy();
    });
  });

  it('does not send the same message twice while it is still being sent', async () => {
    const { source, stream } = fakeSource([]);
    let finishSending = () => {};
    const given = actions();
    given.send.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSending = resolve;
      }),
    );
    const { user } = renderView(source, given);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    await user.type(screen.getByLabelText('発言'), '海の絵{Enter}');
    await user.type(screen.getByLabelText('発言'), '{Enter}');
    await user.click(screen.getByRole('button', { name: /送る/ }));

    expect(given.send).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: /送る/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finishSending());
    expect((screen.getByLabelText('発言') as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps the draft and says why when sending fails', async () => {
    const { source, stream } = fakeSource([]);
    const given = actions();
    given.send.mockRejectedValue(new Error('会話が無い'));
    const { user } = renderView(source, given);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    await user.type(screen.getByLabelText('発言'), '描いて{Enter}');

    expect((await screen.findByRole('alert')).textContent).toContain('会話が無い');
    expect((screen.getByLabelText('発言') as HTMLTextAreaElement).value).toBe('描いて');
  });

  it('offers to resend a message whose turn was cut off by a restart', async () => {
    const events = [
      confirmed({ type: 'user.message', text: '続きを描いて', attachments: [] }),
      confirmed({ type: 'turn.started', turn: 1, messageSeqs: [1] }),
      confirmed({
        type: 'turn.ended',
        turn: 1,
        outcome: 'interrupted',
        reason: 'プロセスの再起動',
      }),
    ];
    const { source } = fakeSource([{ events, last: 3, more: false }]);
    const { actions: given, user } = renderView(source);

    await user.click(await screen.findByRole('button', { name: '送り直す' }));

    expect(given.send).toHaveBeenCalledWith('続きを描いて', expect.any(String), []);
  });

  it('lets a cut-off message be resent only once', async () => {
    const events = [
      confirmed({ type: 'user.message', text: '続きを描いて', attachments: [] }),
      confirmed({ type: 'turn.started', turn: 1, messageSeqs: [1] }),
      confirmed({
        type: 'turn.ended',
        turn: 1,
        outcome: 'interrupted',
        reason: 'プロセスの再起動',
      }),
    ];
    const { source, stream } = fakeSource([{ events, last: 3, more: false }]);
    let finishSending = () => {};
    const given = actions();
    given.send.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSending = resolve;
      }),
    );
    const { user } = renderView(source, given);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    await user.click(await screen.findByRole('button', { name: '送り直す' }));
    expect((screen.getByRole('button', { name: '送り直す' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finishSending());
    stream.emit(confirmed({ type: 'user.message', text: '続きを描いて', attachments: [] }));

    expect(screen.queryByRole('button', { name: '送り直す' })).toBeNull();
    expect(screen.getByText('プロセスの再起動')).toBeTruthy();
    expect(given.send).toHaveBeenCalledTimes(1);
  });

  it('closes the subscription when the screen goes away', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    cleanup();

    expect(stream.closed).toBe(true);
  });

  it('leads to the settings from a failure that settings can fix, and only from those', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(confirmed({ type: 'turn.started', turn: 1, messageSeqs: [] }));
    stream.emit(
      confirmed({
        type: 'turn.ended',
        turn: 1,
        outcome: 'error',
        reason: LLM_NOT_CONFIGURED_REASON,
      }),
    );
    stream.emit(confirmed({ type: 'turn.started', turn: 2, messageSeqs: [] }));
    stream.emit(
      confirmed({
        type: 'turn.ended',
        turn: 2,
        outcome: 'error',
        reason: 'ターンが失敗した: 何か',
      }),
    );
    stream.emit(
      confirmed({
        type: 'job.stopped',
        jobId: JOB,
        reason: { kind: 'error', detail: '繋がらない', backendErrorKind: 'unreachable' },
      }),
    );
    stream.emit(
      confirmed({ type: 'job.stopped', jobId: JOB, reason: { kind: 'human', detail: '止めた' } }),
    );
    // 設定では直らない失敗（バックエンドが処理に失敗した）には、設定への道を添えない
    stream.emit(
      confirmed({
        type: 'job.stopped',
        jobId: JOB,
        reason: { kind: 'error', detail: 'メモリ不足', backendErrorKind: 'failed' },
      }),
    );

    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'LLM の設定へ' })).toHaveLength(1),
    );
    expect(screen.getByRole('link', { name: 'LLM の設定へ' }).getAttribute('href')).toBe(
      '/settings#llm',
    );
    expect(screen.getAllByRole('link', { name: 'バックエンドの設定へ' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'バックエンドの設定へ' }).getAttribute('href')).toBe(
      '/settings#backend',
    );
  });
});
