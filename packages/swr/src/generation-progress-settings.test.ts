// @vitest-environment jsdom
// 生成の途中の画像の設定を読むフックと保存する関数が、/api/settings/generation-progress を叩き、保存した値を画面に置き直すことを見る試験。
// fetch は差し替え、hono/client が組む要求をそのまま受ける
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGenerationProgressSettings } from './hooks.js';
import { keys } from './keys.js';
import { saveGenerationProgressSettings } from './mutations.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  // SWR の既定のキャッシュは試験をまたいで残るので、試験ごとに空にする
  await mutate(keys.generationProgressSettings, undefined, { revalidate: false });
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);

const requestOf = (call: Parameters<typeof fetch>) => {
  const [input, init] = call;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return { url, method: init?.method ?? 'GET', body: init?.body };
};

describe('useGenerationProgressSettings and saveGenerationProgressSettings', () => {
  it('reads the setting, puts the new one and makes the screen show what was saved', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { includePreview: false }));
    const { result } = renderHook(() => useGenerationProgressSettings(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ includePreview: false }));
    expect(requestOf(fetchMock.mock.calls[0]!).url).toContain('/api/settings/generation-progress');

    fetchMock.mockResolvedValue(json(200, { includePreview: true }));
    await saveGenerationProgressSettings({ includePreview: true });

    const put = fetchMock.mock.calls.map(requestOf).find((r) => r.method === 'PUT');
    expect(put?.url).toContain('/api/settings/generation-progress');
    expect(JSON.parse(String(put?.body))).toEqual({ includePreview: true });
    await waitFor(() => expect(result.current.data).toEqual({ includePreview: true }));
  });
});
