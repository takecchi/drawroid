// @vitest-environment jsdom
import {
  ApiError,
  saveBackendSettings,
  saveLlmSettings,
  useBackendStatus,
  useLlmSettings,
} from '@drawroid/swr';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SetupNotice } from './setup-notice';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  useLlmSettings: vi.fn(),
  useBackendStatus: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function given(llm: { config: unknown } | undefined, backendError: ApiError | undefined) {
  vi.mocked(useLlmSettings).mockReturnValue({ data: llm } as never);
  vi.mocked(useBackendStatus).mockReturnValue({
    data: backendError === undefined ? { capabilities: { unavailable: [] } } : undefined,
    error: backendError,
  } as never);
  render(
    <MemoryRouter>
      <SetupNotice />
    </MemoryRouter>,
  );
}

const down = new ApiError('backend_unreachable', 'http://127.0.0.1:7860/ に繋がらない', 502);

describe('SetupNotice', () => {
  it('leads to the LLM settings when the LLM is not set up', () => {
    given({ config: null }, undefined);

    expect(screen.getByText(/LLM が未設定なので、話しかけても返事ができない/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'LLM を設定する' }).getAttribute('href')).toBe(
      '/settings#llm',
    );
    expect(screen.queryByRole('link', { name: 'バックエンドを確かめる' })).toBeNull();
  });

  it('leads to the backend settings when the backend cannot be reached', () => {
    given({ config: { roles: {} } }, down);

    expect(screen.getByText(/描き始めても止まる/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'バックエンドを確かめる' }).getAttribute('href')).toBe(
      '/settings#backend',
    );
    expect(screen.queryByRole('link', { name: 'LLM を設定する' })).toBeNull();
  });

  it('shows nothing once both are set up, nor while the settings are still being read', () => {
    given({ config: { roles: {} } }, undefined);
    expect(screen.queryByRole('note')).toBeNull();
    cleanup();

    given(undefined, undefined);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('is a note, not a live status, so it does not talk over the state of the conversation', () => {
    given({ config: null }, down);

    expect(screen.getByRole('note', { name: 'はじめに要る設定' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('SetupNotice, reading the settings through the API', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  let llmConfig: unknown;
  let backendUp: boolean;

  // 設定の保存と同じ口（API）を、fetch を差し替えて受ける
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@drawroid/swr')>('@drawroid/swr');
    vi.mocked(useLlmSettings).mockImplementation(actual.useLlmSettings);
    vi.mocked(useBackendStatus).mockImplementation(actual.useBackendStatus);
    llmConfig = null;
    backendUp = false;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (url.includes('/api/settings/llm')) {
          if (method === 'PUT') llmConfig = JSON.parse(String(init?.body));
          return json(200, { config: llmConfig, apiKeyEnv: {} });
        }
        if (url.includes('/api/settings/backend')) {
          if (method === 'PUT') backendUp = true;
          return json(200, { url: 'http://127.0.0.1:7860/' });
        }
        if (url.includes('/api/backend')) {
          return backendUp
            ? json(200, { capabilities: { unavailable: [] } })
            : json(502, { error: { kind: 'backend_unreachable', message: '繋がらない' } });
        }
        return json(404, { error: { kind: 'not_found', message: '無い' } });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('goes away once the settings are saved, without opening the screen again', async () => {
    render(
      <MemoryRouter>
        <SetupNotice />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/LLM が未設定なので/)).toBeTruthy();
    expect(await screen.findByText(/描き始めても止まる/)).toBeTruthy();

    await saveLlmSettings({
      providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
      roles: { think: { provider: 'local', model: 'qwen2.5' } },
    });
    await waitFor(() => expect(screen.queryByText(/LLM が未設定なので/)).toBeNull());
    expect(screen.getByText(/描き始めても止まる/)).toBeTruthy();

    await saveBackendSettings({ url: 'http://127.0.0.1:7860/' });
    await waitFor(() => expect(screen.queryByRole('note')).toBeNull());
  });
});
