// @vitest-environment jsdom
// バックエンドの状態を読むフックが、繋がらない間だけ一定の間隔で読み直し、繋がったら止めることを見る試験。
// Forge を後から起動した人の画面から、繋がらないという案内が、開き直さずに消えるように。fetch と setTimeout を差し替える
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKEND_DOWN_RETRY_MS, useBackendStatus } from './hooks.js';
import { keys } from './keys.js';
import { recheckBackendStatus } from './mutations.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const down = () => json(502, { error: { kind: 'backend_unreachable', message: '繋がらない' } });
const up = () => json(200, { capabilities: { unavailable: [] } });

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

// 描画の中で欄を読む: SWR は描画の中で読んだ欄が変わったときだけ描き直すため
const readBackend = () => {
  const { data, error } = useBackendStatus();
  return { data, error };
};

describe('useBackendStatus', () => {
  it('reads the backend again at a steady pace while it cannot be reached', async () => {
    fetchMock.mockImplementation(async () => down());
    const { result } = renderHook(readBackend, { wrapper });
    await passes(0);
    expect(result.current.error?.kind).toBe('backend_unreachable');

    await passes(BACKEND_DOWN_RETRY_MS * 6);

    // 間隔を倍々に延ばす既定の再試行なら、この間に読むのは多くて4回
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  // 定数ではなく時間そのもので見る: 定数ごと短くしても、上の試験は待つ時間も一緒に縮んで通ってしまうため
  it('waits 10 seconds before reading again, not less', async () => {
    fetchMock.mockImplementation(async () => down());
    renderHook(readBackend, { wrapper });
    await passes(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await passes(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await passes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops reading again once the backend answers', async () => {
    fetchMock.mockImplementation(async () => down());
    const { result } = renderHook(readBackend, { wrapper });
    await passes(0);
    expect(result.current.error).toBeDefined();

    fetchMock.mockImplementation(async () => up());
    await passes(BACKEND_DOWN_RETRY_MS);
    expect(result.current.error).toBeUndefined();
    expect(result.current.data).toEqual({ capabilities: { unavailable: [] } });
    const calls = fetchMock.mock.calls.length;

    await passes(BACKEND_DOWN_RETRY_MS * 6);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it('notices the backend went down while it was answering, once asked to read it again', async () => {
    // recheckBackendStatus は既定の取り置きに効くので、この試験は既定の取り置きで読み、終わったら空にする
    const onDefaultCache = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);
    try {
      fetchMock.mockImplementation(async () => up());
      const { result } = renderHook(readBackend, { wrapper: onDefaultCache });
      await passes(0);
      expect(result.current.data).toBeDefined();

      fetchMock.mockImplementation(async () => down());
      // 繋がっている間は読み直さないので、落ちてもまだ気づかない
      await passes(BACKEND_DOWN_RETRY_MS * 6);
      expect(result.current.error).toBeUndefined();

      await act(() => recheckBackendStatus());
      await passes(0);
      expect(result.current.error?.kind).toBe('backend_unreachable');
    } finally {
      await mutate(keys.backend, undefined, { revalidate: false });
    }
  });
});
