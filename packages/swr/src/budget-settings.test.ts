// @vitest-environment jsdom
// 予算を読むフックと保存する関数が、/api/settings/budgets を叩き、保存した値を画面に置き直すことを見る試験。
// fetch は差し替え、hono/client が組む要求をそのまま受ける
import { DEFAULT_BUDGETS } from '@drawroid/core';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isApiError } from './api-error.js';
import { useBudgetSettings } from './hooks.js';
import { keys } from './keys.js';
import { saveBudgetSettings } from './mutations.js';

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
  await mutate(keys.budgetSettings, undefined, { revalidate: false });
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);

const requestOf = (call: Parameters<typeof fetch>) => {
  const [input, init] = call;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return { url, method: init?.method ?? 'GET', body: init?.body };
};

const untouched = { overrides: {}, effective: DEFAULT_BUDGETS, defaults: DEFAULT_BUDGETS };
const stored = {
  overrides: { imageLongEdge: 256 },
  effective: { ...DEFAULT_BUDGETS, imageLongEdge: 256 },
  defaults: DEFAULT_BUDGETS,
};

describe('useBudgetSettings', () => {
  it('reads what was written, the values in effect and the defaults', async () => {
    fetchMock.mockResolvedValue(json(200, stored));

    const { result } = renderHook(() => useBudgetSettings(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(stored));
    expect(requestOf(fetchMock.mock.calls[0]!).url).toContain('/api/settings/budgets');
  });
});

describe('saveBudgetSettings', () => {
  it('puts the overrides and makes the screen show what was saved', async () => {
    fetchMock.mockResolvedValueOnce(json(200, untouched));
    const { result } = renderHook(() => useBudgetSettings(), { wrapper });
    await waitFor(() => expect(result.current.data?.overrides).toEqual({}));

    fetchMock.mockResolvedValue(json(200, stored));
    await saveBudgetSettings({ imageLongEdge: 256 });

    const put = fetchMock.mock.calls.map(requestOf).find((r) => r.method === 'PUT');
    expect(put?.url).toContain('/api/settings/budgets');
    expect(JSON.parse(String(put?.body))).toEqual({ imageLongEdge: 256 });
    await waitFor(() => expect(result.current.data).toEqual(stored));
  });

  it('throws the reason the API gave when the value is out of range', async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: { kind: 'invalid_request', message: 'imageLongEdge: 小さすぎる' } }),
    );

    const error: unknown = await saveBudgetSettings({ imageLongEdge: 1 }).catch((e: unknown) => e);

    expect(isApiError(error)).toBe(true);
    expect((error as Error).message).toBe('imageLongEdge: 小さすぎる');
  });
});
