// @vitest-environment jsdom
import { ApiError, useBackendStatus, useLlmSettings } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
      '/generate#llm',
    );
    expect(screen.queryByRole('link', { name: 'バックエンドを確かめる' })).toBeNull();
  });

  it('leads to the backend settings when the backend cannot be reached', () => {
    given({ config: { roles: {} } }, down);

    expect(screen.getByText(/描き始めても止まる/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'バックエンドを確かめる' }).getAttribute('href')).toBe(
      '/generate#backend',
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
