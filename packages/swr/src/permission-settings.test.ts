// @vitest-environment jsdom
// 全体の既定の許可を読むフックと保存する関数が、/api/settings/permissions を叩き、保存した許可を画面に置くことを見る試験。
// fetch は差し替え、hono/client が組む要求をそのまま受ける
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isApiError } from './api-error.js';
import { usePermissionSettings } from './hooks.js';
import { keys } from './keys.js';
import { savePermissionSettings } from './mutations.js';

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
  await mutate(keys.permissionSettings, undefined, { revalidate: false });
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);

const requestOf = (call: Parameters<typeof fetch>) => {
  const [input, init] = call;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return { url, method: init?.method ?? 'GET', body: init?.body };
};

const stored = {
  overrides: { steps: { mode: 'fixed', value: 28 } },
  permissions: { prompt: { mode: 'auto' }, steps: { mode: 'fixed', value: 28 } },
};

describe('usePermissionSettings', () => {
  it('reads what was written and the permissions in effect', async () => {
    fetchMock.mockResolvedValue(json(200, stored));

    const { result } = renderHook(() => usePermissionSettings(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(stored));
    expect(requestOf(fetchMock.mock.calls[0]!).url).toContain('/api/settings/permissions');
  });
});

describe('savePermissionSettings', () => {
  it('puts the overrides and makes the screen show what was saved', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { overrides: {}, permissions: {} }));
    const { result } = renderHook(() => usePermissionSettings(), { wrapper });
    await waitFor(() => expect(result.current.data?.overrides).toEqual({}));

    fetchMock.mockResolvedValue(json(200, stored));
    await savePermissionSettings({ steps: { mode: 'fixed', value: 28 } });

    const put = fetchMock.mock.calls.map(requestOf).find((r) => r.method === 'PUT');
    expect(put?.url).toContain('/api/settings/permissions');
    expect(JSON.parse(String(put?.body))).toEqual({ steps: { mode: 'fixed', value: 28 } });
    await waitFor(() => expect(result.current.data).toEqual(stored));
  });

  it('throws the reason the API gave when the overrides cannot be taken', async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: { kind: 'invalid_request', message: 'prompt: 使わないは選べない' } }),
    );

    const error: unknown = await savePermissionSettings({}).catch((e: unknown) => e);

    expect(isApiError(error)).toBe(true);
    expect((error as Error).message).toBe('prompt: 使わないは選べない');
  });
});
