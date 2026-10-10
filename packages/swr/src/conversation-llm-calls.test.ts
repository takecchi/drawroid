// @vitest-environment jsdom
// 話す役の LLM 呼び出しの記録を読むフックが、会話の API を叩くことを見る試験。
// fetch は差し替え、hono/client が組む要求をそのまま受ける
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversationLlmCall, useConversationLlmCalls } from './hooks.js';

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
  await mutate(() => true, undefined, { revalidate: false });
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);

const urlOf = (call: Parameters<typeof fetch>) => {
  const [input] = call;
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
};

const ID = '20261009-063012-k3f9';
const listed = {
  calls: [],
  total: {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    inputChars: 0,
    outputChars: 0,
  },
  invalid: [],
};

describe('useConversationLlmCalls', () => {
  it('reads the calls of the conversation from its own URL', async () => {
    fetchMock.mockImplementation(async () => json(200, listed));

    const { result } = renderHook(() => useConversationLlmCalls(ID), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(listed));
    expect(urlOf(fetchMock.mock.calls[0]!)).toMatch(
      new RegExp(`/api/conversations/${ID}/llm-calls$`),
    );
  });

  it('reads nothing until it knows the conversation', () => {
    renderHook(() => useConversationLlmCalls(undefined), { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 話している間は呼び出しが増える: 開いたままの画面に、新しい記録が出るように
  it('reads again by itself while the page stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockImplementation(async () => json(200, listed));
      renderHook(() => useConversationLlmCalls(ID), { wrapper });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(2100);

      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useConversationLlmCall', () => {
  it('reads the whole record of one call from the conversation', async () => {
    const record = { callId: '0001', input: { system: 'S', user: [] } };
    fetchMock.mockImplementation(async () => json(200, record));

    const { result } = renderHook(() => useConversationLlmCall(ID, '0001'), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(record));
    expect(urlOf(fetchMock.mock.calls[0]!)).toMatch(
      new RegExp(`/api/conversations/${ID}/llm-calls/0001$`),
    );
  });

  it('reads nothing until it knows both the conversation and the call', () => {
    renderHook(() => useConversationLlmCall(undefined, '0001'), { wrapper });
    renderHook(() => useConversationLlmCall(ID, undefined), { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
