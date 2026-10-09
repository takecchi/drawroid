// @vitest-environment jsdom
// LLM の設定を読むフックと保存する関数が、/api/settings/llm を叩き、保存のあとに読み直すことを見る試験。
// fetch は差し替え、hono/client が組む要求をそのまま受ける
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { mutate, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isApiError } from './api-error.js';
import { useLlmSettings } from './hooks.js';
import { keys } from './keys.js';
import { saveLlmSettings } from './mutations.js';

const config = {
  providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
  roles: { think: { provider: 'local', model: 'qwen2.5' } },
} as const;

const stored = {
  config: {
    providers: {
      local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' },
      cloud: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
    roles: {
      think: {
        provider: 'local',
        model: 'qwen2.5',
        contextTokens: 8192,
        maxOutputTokens: 1024,
        structuredOutput: 'native',
        imageInput: true,
      },
    },
    validationRetries: 2,
    networkRetries: 2,
  },
  apiKeyEnv: { cloud: { name: 'ANTHROPIC_API_KEY', set: false } },
};

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
  await mutate(keys.llmSettings, undefined, { revalidate: false });
});

// 既定のキャッシュのまま、重ねての取得を止める間隔だけを 0 にする: 保存の関数は既定のキャッシュを mutate するので、
// フックも同じキャッシュを見ていないと、保存のあとに読み直したかを確かめられないため
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);

const requestOf = (call: Parameters<typeof fetch>) => {
  const [input, init] = call;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return { url, method: init?.method ?? 'GET', body: init?.body };
};

describe('useLlmSettings', () => {
  it('reads the LLM settings, with only the names of the key variables and whether they are set', async () => {
    fetchMock.mockResolvedValue(json(200, stored));

    const { result } = renderHook(() => useLlmSettings(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(stored));
    expect(requestOf(fetchMock.mock.calls[0]!).url).toContain('/api/settings/llm');
  });

  it('reads no settings before anything is set', async () => {
    fetchMock.mockResolvedValue(json(200, { config: null }));

    const { result } = renderHook(() => useLlmSettings(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ config: null }));
  });
});

describe('saveLlmSettings', () => {
  it('puts the settings and makes the screen read them back', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { config: null }));
    const { result } = renderHook(() => useLlmSettings(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ config: null }));

    fetchMock.mockResolvedValue(json(200, stored));
    await saveLlmSettings(config);

    const put = fetchMock.mock.calls.map(requestOf).find((r) => r.method === 'PUT');
    expect(put?.url).toContain('/api/settings/llm');
    expect(JSON.parse(String(put?.body))).toEqual(config);
    await waitFor(() => expect(result.current.data).toEqual(stored));
  });

  it('throws the reason the API gave when the settings cannot be built', async () => {
    fetchMock.mockResolvedValue(
      json(400, {
        error: { kind: 'invalid_request', message: '環境変数 ANTHROPIC_API_KEY が入っていない' },
      }),
    );

    const error: unknown = await saveLlmSettings(config).catch((e: unknown) => e);

    expect(isApiError(error)).toBe(true);
    expect((error as Error).message).toBe('環境変数 ANTHROPIC_API_KEY が入っていない');
  });
});
