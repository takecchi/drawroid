// @vitest-environment jsdom
import {
  ADOPTED_STOP,
  AI_STOP,
  HUMAN_STOP,
  LLM_NOT_CONFIGURED_REASON,
  REPEATED_TOOL_CALL_REASON,
  TOOL_THREW_PREFIX,
  type ConversationEvent,
  type JobState,
  type LiveEvent,
  type StopReason,
} from '@drawroid/core';
import {
  addMask,
  adoptImage,
  recheckBackendStatus,
  recheckJobDistill,
  setSelection,
  useJob,
  useJobDistill,
  useSelections,
} from '@drawroid/swr';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationSource, EventPage, StreamLike } from '../lib/conversation-stream';
import { encodeMaskPng } from '../lib/mask-png';
import { ConversationView, jobNameOf, type ConversationActions } from './conversation-view';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  addMask: vi.fn(),
  adoptImage: vi.fn(),
  recheckBackendStatus: vi.fn(),
  recheckJobDistill: vi.fn(),
  setSelection: vi.fn(),
  useJob: vi.fn(),
  useJobDistill: vi.fn(),
  useSelections: vi.fn(),
}));
// jsdom には canvas の描画が無い: マスクを PNG にする所は差し替える
vi.mock('../lib/mask-png', () => ({ encodeMaskPng: vi.fn() }));

const JOB = '20261009-153112-a3f9c1';
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
  vi.mocked(useJob).mockReturnValue({ data: undefined } as never);
  vi.mocked(useJobDistill).mockReturnValue({
    data: undefined,
    error: undefined,
    pending: false,
    exhausted: false,
  } as never);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('the stop card', () => {
  /** 止まったジョブの状態（実行器が state.json に残す形）。best を省けば、最良の画像が無い（1枚もできずに止まった） */
  const stoppedJob = (
    best?: { iteration: number; imageIndex: number; score: number },
    reason: StopReason = AI_STOP,
  ) => {
    const state: JobState = {
      status: 'stopped',
      carry: {
        intent: '海辺',
        completedIterations: 2,
        ...(best !== undefined && {
          best: { ...best, params: { prompt: 'seaside' }, issues: [], nextChange: '' },
        }),
      },
      startedAt: AT,
      stoppedAt: AT,
      imagesGenerated: 4,
      reason,
    };
    return { data: { state } } as never;
  };
  const BEST = { iteration: 2, imageIndex: 1, score: 0.92 };
  const CHOOSE = 'この画像に決める（お気に入りにする）: 2 回目の画像 2 番';

  async function stopWith(reason: StopReason) {
    const { source, stream } = fakeSource([]);
    const view = renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(confirmed({ type: 'job.stopped', jobId: JOB, reason }));
    await waitFor(() => expect(screen.getByText(/描くのを止めた/)).toBeTruthy());
    return view;
  }

  it.each<[string, StopReason]>([
    ['the judge said it is done', AI_STOP],
    ['it reached its limit', { kind: 'limit:iterations', detail: '3 回に達した' }],
  ])('offers the best image to choose when %s', async (_, reason) => {
    vi.mocked(useJob).mockReturnValue(stoppedJob(BEST, reason));
    await stopWith(reason);

    const card = await screen.findByRole('region', { name: '最良の画像: 2 回目の画像 2 番' });
    expect(within(card).getByText('最良: 2 回目の画像 2 番（見る役の点 0.92）')).toBeTruthy();
    // 出す画像は、その最良の画像（2 回目の 2 番）の縮小版
    expect(
      within(card).getByRole('img', { name: '最良: 2 回目の画像 2 番' }).getAttribute('src'),
    ).toBe(`/api/files/jobs/${JOB}/iterations/2/images/1.preview.webp`);
    expect(within(card).getByRole('button', { name: CHOOSE })).toBeTruthy();
    expect(within(card).getByText('続けるなら、話しかけて指示を出す。')).toBeTruthy();
    expect(useJob).toHaveBeenCalledWith(JOB);
  });

  it('chooses the best image through the favorite, since a stopped job takes no adopt', async () => {
    vi.mocked(useJob).mockReturnValue(stoppedJob(BEST));
    const { user } = await stopWith(AI_STOP);

    await user.click(await screen.findByRole('button', { name: CHOOSE }));

    expect(setSelection).toHaveBeenCalledWith(JOB, '2-1', 'favorite');
    // 止まったジョブは採る口を断る（409）ので、採る口は呼ばない
    expect(adoptImage).not.toHaveBeenCalled();
    // 選び直しの蒸留で増える記録を、開き直さずに読み直させる
    await waitFor(() => expect(recheckJobDistill).toHaveBeenCalledWith(JOB));
  });

  it('makes only the card button stand out, while the rows offer the same choice quietly', async () => {
    vi.mocked(useJob).mockReturnValue(stoppedJob(BEST));
    const { source, stream } = fakeSource([]);
    renderView(source);
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
    stream.emit(confirmed({ type: 'job.stopped', jobId: JOB, reason: AI_STOP }));

    const card = await screen.findByRole('region', { name: '最良の画像: 2 回目の画像 2 番' });
    const inCard = within(card).getByRole('button', { name: CHOOSE });
    const inRows = screen.getAllByRole('button', { name: CHOOSE }).filter((b) => b !== inCard);
    // 同じ名前のボタンが行にもあるが、目立つ形（紫）はカードだけ
    expect(inRows).toHaveLength(1);
    expect(inCard.className).toContain('bg-primary');
    expect(inRows[0]!.className).not.toContain('bg-primary');
    // 名前が長いので、どちらも折り返せる
    expect(inCard.className).toContain('whitespace-normal');
    expect(inRows[0]!.className).toContain('whitespace-normal');
  });

  // 折れてよいのは言葉のかたまりの境目だけ（実際に折れないことは、ブラウザの歯が行の数で見る）。
  // 画像の枡は狭いので短い文にし、お気に入りになることは名前と title に残す
  it('breaks the button text only between its phrases, and keeps the text short in the rows', async () => {
    vi.mocked(useJob).mockReturnValue(stoppedJob(BEST));
    const { source, stream } = fakeSource([]);
    renderView(source);
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
    stream.emit(confirmed({ type: 'job.stopped', jobId: JOB, reason: AI_STOP }));

    const card = await screen.findByRole('region', { name: '最良の画像: 2 回目の画像 2 番' });
    const inCard = within(card).getByRole('button', { name: CHOOSE });
    const inRow = screen.getAllByRole('button', { name: CHOOSE }).find((b) => b !== inCard)!;
    /** ボタンの文のかたまりと、その間の折り返しの機会（wbr）。かたまりは、どれもその中では折り返さない */
    const phrases = (button: HTMLElement) =>
      [...button.firstElementChild!.childNodes].map((node) => {
        if (node.nodeName === 'WBR') return '<wbr>';
        expect(node instanceof HTMLElement && node.className.includes('whitespace-nowrap')).toBe(
          true,
        );
        return node.textContent;
      });
    expect(phrases(inCard)).toEqual(['この画像に決める', '<wbr>', '（お気に入りにする）']);
    expect(phrases(inRow)).toEqual(['この画像に決める']);
    expect(inRow.getAttribute('title')).toBe('お気に入りにする');
  });

  it('says it is a favorite instead of the button when the best image already is', async () => {
    vi.mocked(useJob).mockReturnValue(stoppedJob(BEST));
    vi.mocked(useSelections).mockReturnValue({
      data: { selections: [{ imageKey: '2-1', verdict: 'favorite' }] },
    } as never);
    await stopWith(AI_STOP);

    const card = await screen.findByRole('region', { name: '最良の画像: 2 回目の画像 2 番' });
    expect(within(card).getByText('お気に入り')).toBeTruthy();
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('offers the best image when the job failed after making one', async () => {
    const failed: StopReason = { kind: 'error', detail: '見る段: 形が合わない' };
    vi.mocked(useJob).mockReturnValue(stoppedJob(BEST, failed));
    await stopWith(failed);

    expect(await screen.findByRole('button', { name: CHOOSE })).toBeTruthy();
  });

  it('gives only the reason when the job failed before making any image', async () => {
    const failed: StopReason = { kind: 'error', detail: '生成の段: 繋がらない' };
    vi.mocked(useJob).mockReturnValue(stoppedJob(undefined, failed));
    await stopWith(failed);

    expect(screen.getByText(/描くのを止めた/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^最良の画像/ })).toBeNull();
  });

  // 止めたあとも、途中の画像から選べる。止まりの理由は、実行器が人の止めに付けるもの
  it('offers the best image to choose when a person stopped it, through the favorite', async () => {
    vi.mocked(useJob).mockReturnValue(stoppedJob(BEST, HUMAN_STOP));
    const { user } = await stopWith(HUMAN_STOP);

    const card = await screen.findByRole('region', { name: '最良の画像: 2 回目の画像 2 番' });
    expect(within(card).getByText('最良: 2 回目の画像 2 番（見る役の点 0.92）')).toBeTruthy();
    // 止まったジョブは採る口を断る（409）ので、出す口は決めるボタンだけ
    expect(
      within(card)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([CHOOSE]);
    expect(screen.queryByRole('button', { name: /^この画像で決める/ })).toBeNull();
    await user.click(within(card).getByRole('button', { name: CHOOSE }));

    expect(setSelection).toHaveBeenCalledWith(JOB, '2-1', 'favorite');
    expect(adoptImage).not.toHaveBeenCalled();
  });

  it('adds nothing when a person chose an image, and does not even read the job', async () => {
    vi.mocked(useJob).mockReturnValue(stoppedJob(BEST, ADOPTED_STOP));
    await stopWith(ADOPTED_STOP);

    expect(screen.queryByRole('region', { name: /^最良の画像/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^この画像に決める/ })).toBeNull();
    expect(useJob).not.toHaveBeenCalledWith(JOB);
  });
});

describe('what the job taught, on the stop card', () => {
  const distilled = (entries: unknown[], state: { pending?: boolean; exhausted?: boolean } = {}) =>
    ({
      data: { entries },
      error: undefined,
      pending: state.pending ?? false,
      exhausted: state.exhausted ?? false,
    }) as never;

  async function stopWith(reason: object) {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(confirmed({ type: 'job.stopped', jobId: JOB, reason }));
    await waitFor(() => expect(screen.getByText(/描くのを止めた/)).toBeTruthy());
  }
  const learned = () => screen.getByRole('region', { name: 'このジョブから覚えたこと' });

  it('lists what was added, what was changed from what to what, and why it could not learn', async () => {
    vi.mocked(useJobDistill).mockReturnValue(
      distilled([
        {
          kind: 'stopped',
          at: '2026-10-10T05:00:00.000Z',
          added: [{ id: 'm-2', body: '指の崩れは許容しない' }],
          edited: [{ id: 'm-1', before: '彩度は普通', after: '彩度は控えめ' }],
        },
        {
          kind: 'reselection',
          at: '2026-10-10T05:01:00.000Z',
          added: [],
          edited: [],
          failure: '形が合わない',
        },
      ]),
    );
    await stopWith(AI_STOP);

    expect(
      within(learned())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '覚えた: 指の崩れは許容しない',
      '直した: 彩度は普通 → 彩度は控えめ',
      '整理できなかった: 形が合わない',
    ]);
    expect(useJobDistill).toHaveBeenCalledWith(JOB);
  });

  it('says it is still sorting out what it learned while the distill has not been written', async () => {
    vi.mocked(useJobDistill).mockReturnValue(distilled([], { pending: true }));
    await stopWith({ kind: 'limit:iterations', detail: '3 回に達した' });

    expect(within(learned()).getByText('覚えたことを整理しています')).toBeTruthy();
  });

  it('says nothing came out yet, with a way to the memory, once it has stopped reading again', async () => {
    vi.mocked(useJobDistill).mockReturnValue(distilled([], { exhausted: true }));
    await stopWith({ kind: 'error', detail: '見る段: 形が合わない' });

    expect(within(learned()).getByText(/覚えたことは、まだ出ていない/)).toBeTruthy();
    expect(within(learned()).getByRole('link', { name: '記憶' }).getAttribute('href')).toBe(
      '/memory',
    );
  });

  it('keeps what it learned and says it is sorting out the reselection, then that nothing came out yet', async () => {
    const first = [
      {
        kind: 'stopped',
        at: '2026-10-10T05:00:00.000Z',
        added: [{ id: 'm-2', body: '指の崩れは許容しない' }],
        edited: [],
      },
    ];
    vi.mocked(useJobDistill).mockReturnValue(distilled(first, { pending: true }));
    await stopWith(AI_STOP);

    expect(within(learned()).getByText('覚えた: 指の崩れは許容しない')).toBeTruthy();
    expect(within(learned()).getByText('選び直したことを整理しています')).toBeTruthy();
    expect(within(learned()).queryByText('覚えたことを整理しています')).toBeNull();

    vi.mocked(useJobDistill).mockReturnValue(distilled(first, { exhausted: true }));
    cleanup();
    await stopWith(AI_STOP);
    expect(within(learned()).getByText('覚えた: 指の崩れは許容しない')).toBeTruthy();
    expect(within(learned()).getByText(/選び直したことは、まだ出ていない/)).toBeTruthy();
  });

  it('says nothing new was learned when the distill changed nothing', async () => {
    vi.mocked(useJobDistill).mockReturnValue(
      distilled([{ kind: 'stopped', at: '2026-10-10T05:00:00.000Z', added: [], edited: [] }]),
    );
    await stopWith(AI_STOP);

    expect(within(learned()).getByText('新しく覚えたことは無い。')).toBeTruthy();
  });

  it.each([
    ['a person stopped it', HUMAN_STOP],
    ['a person chose an image', ADOPTED_STOP],
  ])('shows nothing and reads nothing when %s', async (_, reason) => {
    vi.mocked(useJobDistill).mockReturnValue(distilled([], { pending: true }));
    await stopWith(reason);

    expect(screen.queryByRole('region', { name: 'このジョブから覚えたこと' })).toBeNull();
    expect(useJobDistill).not.toHaveBeenCalled();
  });
});

describe('telling the jobs of one conversation apart', () => {
  it('names each image after the head of its request, so two jobs do not share names', async () => {
    const { source, stream } = fakeSource([]);
    const { user } = renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    for (const [jobId, request] of [
      ['job-cat', '猫を描いて'],
      ['job-dog', '夕暮れの海辺で犬と遊ぶ少女を描いて'],
    ] as const) {
      stream.emit(
        confirmed({
          type: 'job.started',
          jobId,
          request,
          stopConditions: { aiJudgement: true, maxIterations: 3 },
        }),
      );
      stream.emit(
        confirmed({ type: 'job.images', jobId, iteration: 1, images: [{ index: 0, seed: 7 }] }),
      );
    }

    const cat = await screen.findByRole('button', {
      name: '大きく見る: 猫を描いて 1 回目の画像 1 番（seed 7）',
    });
    // 長い依頼は頭の 12 文字で切る
    expect(
      screen.getByRole('button', {
        name: '大きく見る: 夕暮れの海辺で犬と遊ぶ少… 1 回目の画像 1 番（seed 7）',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'お気に入り: 猫を描いて 1 回目の画像 1 番' }),
    ).toBeTruthy();

    await user.click(cat);
    expect(screen.getByRole('dialog', { name: /猫を描いて 1 回目の画像 1 番/ })).toBeTruthy();
  });

  it('numbers the second job drawn from the same request, so their images still differ', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    for (const jobId of ['job-1', 'job-2']) {
      stream.emit(
        confirmed({
          type: 'job.started',
          jobId,
          request: '猫を描いて',
          stopConditions: { aiJudgement: true, maxIterations: 3 },
        }),
      );
      stream.emit(
        confirmed({ type: 'job.images', jobId, iteration: 1, images: [{ index: 0, seed: 7 }] }),
      );
    }

    expect(
      await screen.findByRole('button', {
        name: '大きく見る: 猫を描いて 1 回目の画像 1 番（seed 7）',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: '大きく見る: 猫を描いて（2） 1 回目の画像 1 番（seed 7）',
      }),
    ).toBeTruthy();
  });

  it('calls a job without a request a manual generation', () => {
    expect(jobNameOf(undefined)).toBe('手動の生成');
    expect(jobNameOf('  ')).toBe('手動の生成');
    expect(jobNameOf('猫を描いて')).toBe('猫を描いて');
    expect(jobNameOf('一二三四五六七八九十一二三')).toBe('一二三四五六七八九十一二…');
  });
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
    // 止まると、選んでいない画像の行は採る口から「この画像に決める（お気に入りにする）」に変わる
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'この画像に決める（お気に入りにする）: 1 回目の画像 2 番',
        }),
      ).toBeTruthy(),
    );
    expect(screen.queryAllByRole('button', { name: /^この画像で決める/ })).toHaveLength(0);
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

  // 読み直すのは、いちばん新しいバックエンドの失敗ごと: 前に一度落ちた会話でも、また落ちたら気づけるように
  it('reads the backend again when another job stops because the backend failed again', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    const failed = (jobId: string) =>
      confirmed({
        type: 'job.stopped',
        jobId,
        reason: { kind: 'error', detail: '生成の段: 繋がらない', backendErrorKind: 'unreachable' },
      });

    stream.emit(failed(JOB));
    await waitFor(() => expect(recheckBackendStatus).toHaveBeenCalledTimes(1));
    stream.emit(failed('20261009-160000-z9y8'));

    await waitFor(() => expect(recheckBackendStatus).toHaveBeenCalledTimes(2));
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

  // ツールの行は人が読む形にする: 生の JSON と作り手向けの断りの文は「詳しく」に畳んで残す
  it('shows a tool row with a human title and a short summary, folding the raw call', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(
      confirmed({
        type: 'tool.call',
        turn: 1,
        callId: 'c1',
        name: 'start_drawing',
        input: { request: '猫', stopConditions: { aiJudgement: true } },
      }),
    );
    stream.emit(
      confirmed({
        type: 'tool.result',
        turn: 1,
        callId: 'c1',
        ok: false,
        // 実行器が残すとおりの形（投げた失敗には頭の言葉が付く）
        summary: `${TOOL_THREW_PREFIX}${REPEATED_TOOL_CALL_REASON}`,
      }),
    );

    const card = await screen.findByRole('group', { name: 'ツール 描き始める: 失敗' });
    expect(
      within(card).getByText('同じ呼び出しはこのターンで済んでいたので、もう一度はしなかった。'),
    ).toBeTruthy();
    const raw = within(card)
      .getByText(/stopConditions/)
      .closest('details');
    expect(raw?.open).toBe(false);
    expect(
      within(card).getByText(`${TOOL_THREW_PREFIX}${REPEATED_TOOL_CALL_REASON}`).closest('details'),
    ).toBe(raw);
  });

  // 要約からはジョブの ID を省き、全文（話す役に返したもの）は「詳しく」に残す。文は実行器が start_drawing の結果に残したもの
  it('leaves the job ID out of the summary of a tool row, keeping the whole result folded', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    const result = 'ジョブ 20261009-222644-6484ae で描き始めた。止める条件: 1000 回まで';

    stream.emit(
      confirmed({
        type: 'tool.call',
        turn: 1,
        callId: 'c1',
        name: 'start_drawing',
        input: { request: '猫' },
      }),
    );
    stream.emit(
      confirmed({ type: 'tool.result', turn: 1, callId: 'c1', ok: true, summary: result }),
    );

    const card = await screen.findByRole('group', { name: 'ツール 描き始める: 済み' });
    expect(within(card).getByText('ジョブで描き始めた。')).toBeTruthy();
    const whole = within(card).getByText(result);
    expect(whole.closest('details')?.open).toBe(false);
  });

  // 様子を見たときの要約は、ジョブの状態の値（running など）で残る（実行器が会話の記録に残した形）。人には言葉で出し、値は「詳しく」に残す
  it('puts the job status of drawing_status into words', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));

    stream.emit(
      confirmed({ type: 'tool.call', turn: 2, callId: 'c2', name: 'drawing_status', input: {} }),
    );
    stream.emit(
      confirmed({ type: 'tool.result', turn: 2, callId: 'c2', ok: true, summary: 'running' }),
    );

    const card = await screen.findByRole('group', {
      name: 'ツール 描いている絵の様子を見る: 済み',
    });
    expect(within(card).getByText('描いている')).toBeTruthy();
    expect(within(card).getByText('running').closest('details')?.open).toBe(false);
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
    expect(screen.getByText('見る役の点 0.45')).toBeTruthy();
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

  it('in the large view, lets a stopped job be settled through the favorite only, and shows the chosen image as chosen', async () => {
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
    // 止まったジョブは採る口を受けないので、止まりのカードと同じく「この画像に決める（お気に入りにする）」になる。押せない理由は出さない
    expect(
      second.queryByRole('button', { name: 'この画像で決める: 2 回目の画像 2 番' }),
    ).toBeNull();
    expect(second.queryByText(/決められない/)).toBeNull();
    await user.click(
      second.getByRole('button', {
        name: 'この画像に決める（お気に入りにする）: 2 回目の画像 2 番',
      }),
    );
    expect(setSelection).toHaveBeenCalledWith(JOB, '2-1', 'favorite');
    expect(adoptImage).not.toHaveBeenCalled();

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

    it('shows the images a message carried, each opening large and named after the message', async () => {
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
      const { user } = renderView(source);

      const attached = await screen.findByRole('list', { name: '添えた画像（2 枚）' });
      expect(
        within(attached)
          .getAllByRole('img')
          .map((image) => image.getAttribute('src')),
      ).toEqual(['/api/conversations/c1/uploads/u-1', '/api/conversations/c1/uploads/u-2']);

      await user.click(
        screen.getByRole('button', {
          name: '大きく見る: 添えた画像 2 枚目（「この2枚で描いて」）',
        }),
      );
      const dialog = within(screen.getByRole('dialog', { name: /添えた画像 2 枚目/ }));
      // 添えた画像は見る役の評価も選ぶボタンも持たず、塗ることもできない
      expect(
        dialog.queryByRole('button', { name: /この画像で決める|この画像に決める/ }),
      ).toBeNull();
      expect(dialog.queryByRole('button', { name: /お気に入り|却下|マスクを塗る/ })).toBeNull();
      expect(dialog.queryByText(/見る役の点/)).toBeNull();
    });

    it('names an attached image after the first 12 characters of a long message', async () => {
      const { source } = fakeSource([
        {
          events: [
            confirmed({
              type: 'user.message',
              text: '一二三四五六七八九十一二三四五',
              attachments: [{ uploadId: 'u-1' }],
            }),
          ],
          last: 1,
          more: false,
        },
      ]);
      renderView(source);

      expect(
        await screen.findByRole('button', {
          name: '大きく見る: 添えた画像 1 枚目（「一二三四五六七八九十一二…」）',
        }),
      ).toBeTruthy();
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

  describe('painting a mask in the large view', () => {
    // 1回目の画像を2枚出し、1枚目を大きく見る窓で開いて、塗り始める
    async function startPainting(extra: ConversationEvent[] = []) {
      vi.mocked(addMask).mockResolvedValue({} as never);
      vi.mocked(encodeMaskPng).mockResolvedValue('PNG-BASE64');
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
      for (const event of extra) stream.emit(event);
      await user.click(screen.getByRole('button', { name: /^大きく見る: 2 回目の画像 1 番/ }));
      const dialog = () => within(screen.getByRole('dialog'));
      return { user, dialog };
    }

    // 原寸の画像（1024×768）が読み込まれたことにし、画面には 512×384 で出ているとする
    function loadOriginal(dialog: () => ReturnType<typeof within>) {
      const img = dialog().getByAltText('2 回目の画像 1 番（seed 8）');
      Object.defineProperty(img, 'naturalWidth', { value: 1024 });
      Object.defineProperty(img, 'naturalHeight', { value: 768 });
      fireEvent.load(img);
      const canvas = dialog().getByLabelText('マスクを塗る所');
      canvas.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          width: 512,
          height: 384,
          right: 512,
          bottom: 384,
          x: 0,
          y: 0,
        }) as DOMRect;
      return canvas;
    }

    function paint(canvas: HTMLElement) {
      fireEvent.pointerDown(canvas, { clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 256, clientY: 192, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 256, clientY: 192, pointerId: 1 });
    }

    it('says the original is loading before showing where to paint, then sends the mask through the same API as the job page', async () => {
      const { user, dialog } = await startPainting();
      await user.click(dialog().getByRole('button', { name: 'マスクを塗る' }));

      expect(dialog().getByText('原寸の画像を読み込んでいます…')).toBeTruthy();
      expect(dialog().getByLabelText('マスクを塗る所').parentElement?.className).toContain(
        'hidden',
      );

      const canvas = loadOriginal(dialog);
      expect(dialog().queryByText('原寸の画像を読み込んでいます…')).toBeNull();
      paint(canvas);
      await user.click(dialog().getByRole('button', { name: 'マスクを送る' }));

      expect(addMask).toHaveBeenCalledWith(JOB, { iteration: 2, index: 0 }, 'PNG-BASE64');
      expect(await dialog().findByText(/送った/)).toBeTruthy();
      // 送ったら見る形に戻る: 塗る面は消え、「マスクを塗る」に戻り、送ったことを短く出す。前後へ送れる
      expect(dialog().getByText('マスクを送った。次の回で描き直す。')).toBeTruthy();
      expect(dialog().queryByLabelText('マスクを塗る所')).toBeNull();
      expect(dialog().getByRole('button', { name: 'マスクを塗る' })).toBeTruthy();
      expect(dialog().queryByText(/塗っている間は前後へ送れない/)).toBeNull();
      expect(dialog().getByRole('button', { name: '次の画像' })).toHaveProperty('disabled', false);
      // 送ったら塗りかけは残らないので、閉じないとは言わず、Esc で閉じる
      expect(dialog().queryByText(/Esc や窓の外を押しても閉じない/)).toBeNull();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('closes on Escape while painting with nothing painted yet, without saying it stays open', async () => {
      const { user, dialog } = await startPainting();
      await user.click(dialog().getByRole('button', { name: 'マスクを塗る' }));
      loadOriginal(dialog);

      expect(dialog().getByText(/塗っている間は前後へ送れない/)).toBeTruthy();
      expect(dialog().queryByText(/Esc や窓の外を押しても閉じない/)).toBeNull();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('does not move to another image while painting, and says so', async () => {
      const { user, dialog } = await startPainting();
      await user.click(dialog().getByRole('button', { name: 'マスクを塗る' }));

      await user.keyboard('{ArrowRight}');

      expect(screen.getByRole('dialog', { name: /2 回目の画像 1 番/ })).toBeTruthy();
      expect(dialog().getByText(/塗っている間は前後へ送れない/)).toBeTruthy();
      expect(dialog().getByRole('button', { name: '次の画像' })).toHaveProperty('disabled', true);
    });

    it('stays open on Escape while something is painted, and the close button throws the painting away', async () => {
      const { user, dialog } = await startPainting();
      await user.click(dialog().getByRole('button', { name: 'マスクを塗る' }));
      paint(loadOriginal(dialog));

      await user.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(dialog().getByText(/Esc や窓の外を押しても閉じない/)).toBeTruthy();

      await user.click(dialog().getByRole('button', { name: '閉じる' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await user.click(screen.getByRole('button', { name: /^大きく見る: 2 回目の画像 1 番/ }));
      expect(dialog().queryByLabelText('マスクを塗る所')).toBeNull();
      expect(dialog().getByRole('button', { name: 'マスクを塗る' })).toBeTruthy();
    });

    it('goes back to viewing, and moving again, when painting is given up', async () => {
      const { user, dialog } = await startPainting();
      await user.click(dialog().getByRole('button', { name: 'マスクを塗る' }));
      paint(loadOriginal(dialog));

      await user.click(dialog().getByRole('button', { name: '塗るのをやめる' }));
      await user.keyboard('{ArrowRight}');

      expect(screen.getByRole('dialog', { name: /2 回目の画像 2 番/ })).toBeTruthy();
      expect(addMask).not.toHaveBeenCalled();
    });

    it('offers no mask painting for the images of a job that has stopped', async () => {
      const { dialog } = await startPainting([
        confirmed({ type: 'job.stopped', jobId: JOB, reason: { kind: 'human', detail: '止めた' } }),
      ]);

      expect(dialog().queryByRole('button', { name: 'マスクを塗る' })).toBeNull();
    });
  });
});

// 足した文は「〜する」の調子にそろえる（#284）
describe('the wording of the conversation', () => {
  it('asks to talk in the same tone as the rest, while the conversation is empty', async () => {
    const { source } = fakeSource([]);
    renderView(source);

    expect(await screen.findByText('描いてほしいものや、聞きたいことを話しかける。')).toBeTruthy();
  });

  it('says where to choose an image in the same tone, while an image is being made', async () => {
    const { source, stream } = fakeSource([]);
    renderView(source);
    await waitFor(() => expect(stream.listeners.size).toBeGreaterThan(0));
    stream.emit(
      confirmed({
        type: 'job.started',
        jobId: JOB,
        request: '夕暮れの海',
        stopConditions: { aiJudgement: true, maxIterations: 3 },
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

    expect(
      await screen.findByText('できあがったら、画像の行の「この画像で決める」で選べる'),
    ).toBeTruthy();
  });
});
