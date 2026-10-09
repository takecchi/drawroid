// @vitest-environment jsdom
import type { ConversationEvent, LiveEvent } from '@drawroid/core';
import { setSelection, useSelections } from '@drawroid/swr';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationSource, EventPage, StreamLike } from '../lib/conversation-stream';
import { ConversationView, type ConversationActions } from './conversation-view';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
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

    expect(given.send).toHaveBeenCalledWith('これでいいから次はこうして', expect.any(String));
    expect(given.stop).toHaveBeenCalled();
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

    expect(given.send).toHaveBeenCalledWith('続きを描いて', expect.any(String));
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
});
