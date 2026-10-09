// @vitest-environment jsdom
// ジョブ一覧の区画が「走行中 → 待ち → 終了」の順に出ることを見る試験（#68 の J4）
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobList } from './job-list';

const mocks = vi.hoisted(() => ({ useJobs: vi.fn(), useBackendSettings: vi.fn() }));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  useJobs: mocks.useJobs,
  useBackendSettings: mocks.useBackendSettings,
}));

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.useBackendSettings.mockReturnValue({ data: undefined, error: undefined });
});

describe('JobList', () => {
  it('says once that there is no job yet, instead of three empty sections', () => {
    mocks.useJobs.mockReturnValue({ data: { jobs: [], invalid: [] }, error: undefined });
    render(
      <MemoryRouter>
        <JobList />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('まだ無い。')).toHaveLength(1);
  });

  it('shows the running section first, then the queued, then the stopped', () => {
    mocks.useJobs.mockReturnValue({
      data: {
        // 入力の順は区画の順と逆にしておく: 入力の順のまま出しても通らないように
        jobs: [
          {
            jobId: 'stopped-1',
            kind: 'auto',
            createdAt: '2026-10-09T00:00:00Z',
            state: { status: 'stopped', reason: { kind: 'human', detail: '人間が止めた' } },
          },
          {
            jobId: 'queued-1',
            kind: 'auto',
            createdAt: '2026-10-09T00:01:00Z',
            state: { status: 'queued' },
          },
          {
            jobId: 'running-1',
            kind: 'auto',
            createdAt: '2026-10-09T00:02:00Z',
            state: { status: 'running' },
          },
        ],
        invalid: [],
      },
      error: undefined,
    });
    render(
      <MemoryRouter>
        <JobList />
      </MemoryRouter>,
    );

    const headings = screen
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '')
      .filter((text) => /（\d+）$/.test(text));
    expect(headings).toEqual(['走行中（1）', '待ち（1）', '終了（1）']);
  });
});
