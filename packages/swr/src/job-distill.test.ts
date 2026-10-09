// @vitest-environment jsdom
// ジョブから覚えたことを読むフックが、記録がまだ無い間だけ間隔を伸ばしながら読み直し、記録が出たら止め、尽きたら止めることを見る試験。
// fetch と setTimeout を差し替える
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JOB_DISTILL_RETRY_MS, useJobDistill } from './hooks.js';
import { keys } from './keys.js';
import { recheckJobDistill } from './mutations.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const none = () => json(200, { entries: [] });
const learned = () =>
  json(200, {
    entries: [
      {
        kind: 'stopped',
        at: '2026-10-10T05:00:00.000Z',
        added: [{ id: 'm-1', body: '指' }],
        edited: [],
      },
    ],
  });

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// 試験ごとに空のキャッシュで読む
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);
const passes = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const total = JOB_DISTILL_RETRY_MS.reduce((sum, ms) => sum + ms, 0);

describe('useJobDistill', () => {
  it('reads again with growing waits while nothing is learned yet, and stops once it is', async () => {
    fetchMock.mockImplementation(async () => none());
    const { result } = renderHook(() => useJobDistill('job-1'), { wrapper });
    await passes(0);
    expect(result.current.pending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/jobs/job-1/distill');

    // 最初の間隔の手前では読まない。間隔が来たら1回読む
    await passes(JOB_DISTILL_RETRY_MS[0] - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await passes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 次の間隔は伸びる
    await passes(JOB_DISTILL_RETRY_MS[1] - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(async () => learned());
    await passes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.pending).toBe(false);
    expect(result.current.data?.entries).toHaveLength(1);

    await passes(total * 2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after a bounded number of reads, and says so', async () => {
    fetchMock.mockImplementation(async () => none());
    const { result } = renderHook(() => useJobDistill('job-1'), { wrapper });
    await passes(0);

    // 間隔ごとに進める: 次の読み直しは、前の読みの結果を描いたあとに置かれるため
    for (const ms of JOB_DISTILL_RETRY_MS) await passes(ms);
    expect(fetchMock).toHaveBeenCalledTimes(1 + JOB_DISTILL_RETRY_MS.length);
    expect(result.current.exhausted).toBe(true);
    expect(result.current.pending).toBe(false);

    await passes(total * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1 + JOB_DISTILL_RETRY_MS.length);
  });

  it('reads nothing without a job', async () => {
    renderHook(() => useJobDistill(undefined), { wrapper });
    await passes(total);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('after a person chose an image of the stopped job', () => {
    // recheckJobDistill は既定の取り置きに印を置くので、既定の取り置きで読み、終わったら空にする
    const onDefaultCache = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);
    afterEach(async () => {
      await mutate(keys.jobDistill('job-1'), undefined, { revalidate: false });
      await mutate(keys.jobDistillWait('job-1'), undefined, { revalidate: false });
    });
    const entries = (n: number) =>
      json(200, {
        entries: Array.from({ length: n }, (_, i) => ({
          kind: i === 0 ? 'stopped' : 'reselection',
          at: `2026-10-10T05:0${i}:00.000Z`,
          added: [],
          edited: [],
        })),
      });

    it('reads again, with the same growing waits, until the reselection adds an entry', async () => {
      fetchMock.mockImplementation(async () => entries(1));
      const { result } = renderHook(() => useJobDistill('job-1'), { wrapper: onDefaultCache });
      await passes(0);
      // 記録があるので、選び直すまでは読み直さない
      await passes(total);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.pending).toBe(false);

      await act(() => recheckJobDistill('job-1'));
      expect(result.current.pending).toBe(true);
      await passes(JOB_DISTILL_RETRY_MS[0]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fetchMock.mockImplementation(async () => entries(2));
      await passes(JOB_DISTILL_RETRY_MS[1]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.current.pending).toBe(false);
      expect(result.current.data?.entries).toHaveLength(2);

      await passes(total * 2);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('gives up after the same bound when the reselection adds nothing', async () => {
      fetchMock.mockImplementation(async () => entries(1));
      const { result } = renderHook(() => useJobDistill('job-1'), { wrapper: onDefaultCache });
      await passes(0);

      await act(() => recheckJobDistill('job-1'));
      for (const ms of JOB_DISTILL_RETRY_MS) await passes(ms);

      expect(fetchMock).toHaveBeenCalledTimes(1 + JOB_DISTILL_RETRY_MS.length);
      expect(result.current.exhausted).toBe(true);
      await passes(total * 2);
      expect(fetchMock).toHaveBeenCalledTimes(1 + JOB_DISTILL_RETRY_MS.length);
    });

    it('does not read again a job nobody chose an image of', async () => {
      fetchMock.mockImplementation(async () => entries(1));
      renderHook(() => useJobDistill('job-1'), { wrapper: onDefaultCache });
      await passes(0);
      const before = fetchMock.mock.calls.length;

      await act(() => recheckJobDistill('job-2'));
      await passes(total);

      expect(fetchMock).toHaveBeenCalledTimes(before);
    });
  });
});

// 間隔と回数は、定数ではなく時間そのもので見る: 定数ごと変えると、待つ時間も一緒に縮んで試験が気づかないため
describe('useJobDistill, in seconds', () => {
  it('reads again after 2, 4, 8, 16, 30 and 60 seconds, and no more', async () => {
    fetchMock.mockImplementation(async () => none());
    const { result } = renderHook(() => useJobDistill('job-1'), { wrapper });
    await passes(0);

    let reads = 1;
    for (const ms of [2_000, 4_000, 8_000, 16_000, 30_000, 60_000]) {
      await passes(ms - 1);
      expect(fetchMock).toHaveBeenCalledTimes(reads);
      await passes(1);
      reads += 1;
      expect(fetchMock).toHaveBeenCalledTimes(reads);
    }
    expect(result.current.exhausted).toBe(true);

    await passes(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('does not say it gave up when the last read finds what was learned', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => (++calls < 7 ? none() : learned()));
    const { result } = renderHook(() => useJobDistill('job-1'), { wrapper });
    await passes(0);

    for (const ms of JOB_DISTILL_RETRY_MS) await passes(ms);

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result.current.data?.entries).toHaveLength(1);
    expect(result.current.exhausted).toBe(false);
    expect(result.current.pending).toBe(false);
  });
});

// 選び直したあとの読み直しも、時間そのもので見る（#276: 同じ間隔 2・4・8・16・30・60 秒、押すたびに回数を数え直す）
describe('useJobDistill after a reselection, in seconds', () => {
  const onDefaultCache = ({ children }: { children: ReactNode }) =>
    createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);
  afterEach(async () => {
    await mutate(keys.jobDistill('job-1'), undefined, { revalidate: false });
    await mutate(keys.jobDistillWait('job-1'), undefined, { revalidate: false });
  });
  const oneEntry = () =>
    json(200, {
      entries: [{ kind: 'stopped', at: '2026-10-10T05:00:00.000Z', added: [], edited: [] }],
    });

  it('reads again after 2, 4, 8, 16, 30 and 60 seconds once an image is chosen', async () => {
    fetchMock.mockImplementation(async () => oneEntry());
    renderHook(() => useJobDistill('job-1'), { wrapper: onDefaultCache });
    await passes(0);
    await act(() => recheckJobDistill('job-1'));

    let reads = 1;
    for (const ms of [2_000, 4_000, 8_000, 16_000, 30_000, 60_000]) {
      await passes(ms - 1);
      expect(fetchMock).toHaveBeenCalledTimes(reads);
      await passes(1);
      reads += 1;
      expect(fetchMock).toHaveBeenCalledTimes(reads);
    }
    await passes(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('counts the reads again from the start each time an image is chosen', async () => {
    fetchMock.mockImplementation(async () => oneEntry());
    const { result } = renderHook(() => useJobDistill('job-1'), { wrapper: onDefaultCache });
    await passes(0);
    await act(() => recheckJobDistill('job-1'));
    for (const ms of JOB_DISTILL_RETRY_MS) await passes(ms);
    expect(result.current.exhausted).toBe(true);
    const before = fetchMock.mock.calls.length;

    // 尽きたあとにもう一度選ぶと、また最初の間隔から読み直す
    // 印は押した時刻（Date.now()）で見分けるので、同じミリ秒に押さないよう、時計が進むのを待つ（Date は差し替えていない）
    const pressedAt = Date.now();
    while (Date.now() === pressedAt) {
      // 1 ms も待たない
    }
    await act(() => recheckJobDistill('job-1'));
    expect(result.current.pending).toBe(true);
    await passes(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(before + 1);
  });
});
