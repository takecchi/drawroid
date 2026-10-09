// @vitest-environment jsdom
// 候補の説明を読むフックと保存する関数が、/api/backend/candidate-notes を叩き、保存した説明を画面に置くことを見る試験。
// fetch は差し替え、hono/client が組む要求をそのまま受ける
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isApiError } from './api-error.js';
import { useCandidateNotes } from './hooks.js';
import { keys } from './keys.js';
import { saveCandidateNotes } from './mutations.js';

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
  await mutate(keys.candidateNotes, undefined, { revalidate: false });
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);

const requestOf = (call: Parameters<typeof fetch>) => {
  const [input, init] = call;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return { url, method: init?.method ?? 'GET', body: init?.body };
};

describe('useCandidateNotes', () => {
  it('reads the notes, and why the file could not be read when it could not', async () => {
    const stored = {
      notes: { 'detail.safetensors': '細部を足す' },
      problem: 'JSON として読めない',
    };
    fetchMock.mockResolvedValue(json(200, stored));

    const { result } = renderHook(() => useCandidateNotes(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(stored));
    expect(requestOf(fetchMock.mock.calls[0]!).url).toContain('/api/backend/candidate-notes');
  });
});

describe('saveCandidateNotes', () => {
  it('puts all the notes and makes the screen show what was saved', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: {} }));
    const { result } = renderHook(() => useCandidateNotes(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ notes: {} }));

    const notes = { 'detail.safetensors': '細部を足す' };
    fetchMock.mockResolvedValue(json(200, { notes }));
    await saveCandidateNotes(notes);

    const put = fetchMock.mock.calls.map(requestOf).find((r) => r.method === 'PUT');
    expect(put?.url).toContain('/api/backend/candidate-notes');
    expect(JSON.parse(String(put?.body))).toEqual(notes);
    await waitFor(() => expect(result.current.data).toEqual({ notes }));
  });

  it('throws the reason the API gave when the notes cannot be taken', async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: { kind: 'invalid_request', message: 'detail: 200 文字を超えている' } }),
    );

    const error: unknown = await saveCandidateNotes({ detail: 'x' }).catch((e: unknown) => e);

    expect(isApiError(error)).toBe(true);
    expect((error as Error).message).toBe('detail: 200 文字を超えている');
  });
});
