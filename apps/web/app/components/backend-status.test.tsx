// @vitest-environment jsdom
import { useBackendSettings, useBackendStatus } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendErrorMessage } from './backend-error-message';
import { BackendStatus } from './backend-status';
import { StopReasonMessage } from './stop-reason-message';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  useBackendStatus: vi.fn(),
  useBackendSettings: vi.fn(),
}));

const status = vi.mocked(useBackendStatus);
const settings = vi.mocked(useBackendSettings);

function chosenBackend(kind: 'forge' | 'a1111' | undefined) {
  settings.mockReturnValue({
    data: kind === undefined ? undefined : { kind },
  } as unknown as ReturnType<typeof useBackendSettings>);
}

beforeEach(() => chosenBackend('forge'));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function failedStatus(kind: string, message: string) {
  const { ApiError } = await vi.importActual<typeof import('@drawroid/swr')>('@drawroid/swr');
  status.mockReturnValue({
    data: undefined,
    error: new ApiError(kind, message, 502),
    isLoading: false,
  } as unknown as ReturnType<typeof useBackendStatus>);
}

describe('BackendStatus', () => {
  it('explains an unreachable backend and shows the raw message with the URL', async () => {
    await failedStatus('unreachable', 'http://127.0.0.1:7860 に繋がらない');
    render(<BackendStatus />);

    expect(screen.getByText('Forge に繋がらない。')).toBeTruthy();
    expect(screen.getByText(/URL とポートが合っているか/)).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:7860 に繋がらない')).toBeTruthy();
  });

  // 説明があるときは、生の文を「詳しく」に畳む: 生の文にはサーバの言い方で同じ「すること」が入っていて、同じ文が2回並ぶため
  it('folds the raw message under 詳しく when it explains the error, and shows it as is when it cannot', async () => {
    await failedStatus('unreachable', 'http://127.0.0.1:7860 に繋がらない');
    const { unmount } = render(<BackendStatus />);
    const folded = screen.getByText('http://127.0.0.1:7860 に繋がらない').closest('details');
    expect(folded?.open).toBe(false);
    expect(folded?.querySelector('summary')?.textContent).toBe('詳しく');
    unmount();

    await failedStatus('network', 'drawroid の API に繋がらない');
    render(<BackendStatus />);
    expect(screen.getByText('drawroid の API に繋がらない').closest('details')).toBeNull();
  });

  it('explains a missing Forge API and shows the raw message with the URL', async () => {
    await failedStatus('not_found', 'http://127.0.0.1:7860/sdapi/v1/options は 404');
    render(<BackendStatus />);

    expect(screen.getByText('繋がったが Forge の API が無い。')).toBeTruthy();
    expect(screen.getByText(/--api 付きで起動していない/)).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:7860/sdapi/v1/options は 404')).toBeTruthy();
  });

  it('shows the kind and the raw message for an error that is not a backend error', async () => {
    await failedStatus('network', 'drawroid の API に繋がらない');
    render(<BackendStatus />);

    expect(screen.getByText('失敗した（network）')).toBeTruthy();
    expect(screen.getByText('drawroid の API に繋がらない')).toBeTruthy();
  });

  it('says it is checking while the status is loading', () => {
    status.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useBackendStatus>);
    render(<BackendStatus />);

    expect(screen.getByText('確認しています。')).toBeTruthy();
  });

  it('lists the features that are unavailable when connected', () => {
    status.mockReturnValue({
      data: { capabilities: { unavailable: [{ feature: 'lora', reason: '拡張が無い' }] } },
      error: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useBackendStatus>);
    render(<BackendStatus />);

    expect(screen.getByText('繋がっている。')).toBeTruthy();
    expect(screen.getByText('lora: 拡張が無い')).toBeTruthy();
  });
});

describe('BackendErrorMessage', () => {
  it('explains each backend error kind it knows and keeps the raw message', () => {
    render(<BackendErrorMessage kind="unauthorized" message="401 from http://forge.local" />);

    expect(screen.getByText('認証に失敗した。')).toBeTruthy();
    expect(screen.getByText('401 from http://forge.local')).toBeTruthy();
  });
});

describe('BackendErrorMessage naming the chosen backend', () => {
  it.each([
    ['unreachable', 'A1111 に繋がらない。'],
    ['not_found', '繋がったが A1111 の API が無い。'],
  ])('names A1111 for %s when A1111 is chosen', (kind, summary) => {
    chosenBackend('a1111');
    render(<BackendErrorMessage kind={kind} message="m" />);

    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.queryByText(/Forge/)).toBeNull();
  });

  it('names A1111 in the unauthorized action when A1111 is chosen', () => {
    chosenBackend('a1111');
    render(<BackendErrorMessage kind="unauthorized" message="m" />);

    expect(screen.getByText(/A1111 の --api-auth/)).toBeTruthy();
    expect(screen.queryByText(/Forge/)).toBeNull();
  });

  it('names no specific backend while the chosen one is unknown', () => {
    chosenBackend(undefined);
    render(<BackendErrorMessage kind="unreachable" message="m" />);

    expect(screen.getByText('バックエンド（Forge / A1111）に繋がらない。')).toBeTruthy();
  });
});

describe('StopReasonMessage', () => {
  it('explains a backend failure with the chosen backend name when A1111 is chosen', () => {
    chosenBackend('a1111');
    render(
      <StopReasonMessage
        reason={{ kind: 'error', detail: 'd', backendErrorKind: 'unreachable' }}
      />,
    );

    expect(screen.getByText('A1111 に繋がらない。')).toBeTruthy();
  });

  it('reports a failure outside A1111 when A1111 is chosen', () => {
    chosenBackend('a1111');
    render(<StopReasonMessage reason={{ kind: 'error', detail: 'ENOSPC' }} />);

    expect(screen.getByText(/A1111 の外で失敗した/)).toBeTruthy();
    expect(screen.queryByText(/Forge/)).toBeNull();
  });

  it('explains a backend failure that stopped the job, with the raw detail', () => {
    render(
      <StopReasonMessage
        reason={{
          kind: 'error',
          detail: 'http://127.0.0.1:7860 に繋がらない',
          backendErrorKind: 'unreachable',
        }}
      />,
    );

    expect(screen.getByText('Forge に繋がらない。')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:7860 に繋がらない')).toBeTruthy();
  });

  it('explains a missing Forge API that stopped the job', () => {
    render(
      <StopReasonMessage
        reason={{ kind: 'error', detail: 'http://x/sdapi は 404', backendErrorKind: 'not_found' }}
      />,
    );

    expect(screen.getByText('繋がったが Forge の API が無い。')).toBeTruthy();
    expect(screen.getByText('http://x/sdapi は 404')).toBeTruthy();
  });

  it('reports a failure without a backend error kind as outside Forge', () => {
    render(<StopReasonMessage reason={{ kind: 'error', detail: 'ENOSPC: 保存できない' }} />);

    expect(screen.getByText(/Forge の外で失敗した/)).toBeTruthy();
    expect(screen.getByText('ENOSPC: 保存できない')).toBeTruthy();
    expect(screen.queryByText(/Forge に繋がらない/)).toBeNull();
  });

  it('shows only the summary for a stop that was not an error', () => {
    render(<StopReasonMessage reason={{ kind: 'human', detail: '人が止めた' }} />);

    expect(screen.getByText('止まった理由: 人が止めた')).toBeTruthy();
  });
});
