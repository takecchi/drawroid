// @vitest-environment jsdom
// 会話の一覧・確定イベントを読む口と、会話を作る・名前を直す・発言する・中断する関数が、会話の API を叩くことを見る試験。
// fetch は差し替え、hono/client が組む要求をそのまま受ける
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isApiError } from './api-error.js';
import { useConversationEvents, useConversations } from './hooks.js';
import { keys } from './keys.js';
import {
  conversationStreamUrl,
  createConversation,
  interruptConversation,
  loadConversationEvents,
  postConversationMessage,
  renameConversation,
} from './mutations.js';

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

const requestOf = (call: Parameters<typeof fetch>) => {
  const [input, init] = call;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return { url, method: init?.method ?? 'GET', body: init?.body };
};

const ID = '20261009-063012-k3f9';
const conversation = { conversationId: ID, title: '', createdAt: '2026-10-09T06:30:12.000Z' };
const page = {
  events: [
    {
      type: 'user.message',
      seq: 1,
      at: '2026-10-09T06:30:13.000Z',
      text: 'こんにちは',
      attachments: [],
    },
  ],
  last: 1,
  more: false,
};

describe('reading conversations', () => {
  it('reads the list of conversations', async () => {
    const listed = {
      conversations: [{ ...conversation, title: '海辺', lastMessage: '描いて', running: false }],
    };
    fetchMock.mockResolvedValue(json(200, listed));

    const { result } = renderHook(() => useConversations(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(listed));
    expect(requestOf(fetchMock.mock.calls[0]!).url).toMatch(/\/api\/conversations$/);
  });

  it('reads a page of confirmed events after a seq, through the hook and the plain function', async () => {
    // 呼ばれるたびに新しい応答を返す: 応答の本文は一度しか読めないため
    fetchMock.mockImplementation(async () => json(200, page));

    const { result } = renderHook(() => useConversationEvents(ID), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(page));
    expect(await loadConversationEvents(ID, 5)).toEqual(page);

    const urls = fetchMock.mock.calls.map((c) => requestOf(c).url);
    expect(urls[0]).toContain(`/api/conversations/${ID}/events?after=0`);
    expect(urls.at(-1)).toContain(`/api/conversations/${ID}/events?after=5`);
  });

  it('gives the URL to open the stream from after a seq', () => {
    expect(conversationStreamUrl(ID, 7)).toBe(`/api/conversations/${ID}/stream?after=7`);
  });
});

describe('changing conversations', () => {
  it('creates a conversation and makes the list read itself again', async () => {
    fetchMock.mockResolvedValue(json(201, { conversation }));

    expect(await createConversation()).toEqual(conversation);
    expect(requestOf(fetchMock.mock.calls[0]!)).toMatchObject({ method: 'POST' });
  });

  it('renames a conversation', async () => {
    fetchMock.mockResolvedValue(json(200, { conversation: { ...conversation, title: '海辺' } }));

    await renameConversation(ID, '海辺');

    const patch = requestOf(fetchMock.mock.calls[0]!);
    expect(patch).toMatchObject({ method: 'PATCH' });
    expect(patch.url).toContain(`/api/conversations/${ID}`);
    expect(JSON.parse(String(patch.body))).toEqual({ title: '海辺' });
  });

  it('posts a message with its clientMessageId and answers the seq it was confirmed at', async () => {
    fetchMock.mockResolvedValue(json(202, { seq: 3 }));

    expect(await postConversationMessage(ID, '描いて', 'm-1')).toEqual({ seq: 3 });

    const post = requestOf(fetchMock.mock.calls[0]!);
    expect(post.url).toContain(`/api/conversations/${ID}/messages`);
    expect(JSON.parse(String(post.body))).toEqual({ text: '描いて', clientMessageId: 'm-1' });
  });

  it('asks to interrupt the turn or everything', async () => {
    fetchMock.mockResolvedValue(json(202, { scope: 'all' }));

    await interruptConversation(ID, 'all');

    const post = requestOf(fetchMock.mock.calls[0]!);
    expect(post.url).toContain(`/api/conversations/${ID}/interrupt`);
    expect(JSON.parse(String(post.body))).toEqual({ scope: 'all' });
  });

  it('throws the reason the API gave', async () => {
    fetchMock.mockResolvedValue(
      json(404, { error: { kind: 'not_found', message: `会話 ${ID} は無い` } }),
    );

    const error: unknown = await postConversationMessage(ID, 'x', 'm-2').catch((e: unknown) => e);

    expect(isApiError(error)).toBe(true);
    expect((error as Error).message).toBe(`会話 ${ID} は無い`);
  });
});

it('keeps the keys for conversations in one place', () => {
  expect(keys.conversations).toBe('/api/conversations');
});
