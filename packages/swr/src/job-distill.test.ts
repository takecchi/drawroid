// @vitest-environment jsdom
// ジョブから覚えたことを読むフックが、記録がまだ無い間だけ間隔を伸ばしながら読み直し、記録が出たら止め、尽きたら止めることを見る試験。
// fetch と setTimeout を差し替える
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JOB_DISTILL_RETRY_MS, useJobDistill } from './hooks.js';

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
});
