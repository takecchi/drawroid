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

  it('shows what each job was asked to draw, cut short when it is long', () => {
    const long = '夕暮れの海辺に立つ白いワンピースの少女、アニメ調、'.repeat(10);
    mocks.useJobs.mockReturnValue({
      data: {
        jobs: [
          {
            jobId: 'auto-1',
            kind: 'auto',
            createdAt: '2026-10-09T00:00:00Z',
            request: '猫の絵',
            state: { status: 'queued' },
          },
          {
            jobId: 'manual-1',
            kind: 'manual',
            createdAt: '2026-10-09T00:01:00Z',
            request: long,
            state: { status: 'queued' },
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

    expect(screen.getByText('猫の絵')).toBeTruthy();
    expect(screen.queryByText(long)).toBeNull();
    expect(screen.getByText(`${[...long].slice(0, 60).join('')}…`)).toBeTruthy();
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
            request: '猫',
            state: { status: 'stopped', reason: { kind: 'human', detail: '人間が止めた' } },
          },
          {
            jobId: 'queued-1',
            kind: 'auto',
            createdAt: '2026-10-09T00:01:00Z',
            request: '犬',
            state: { status: 'queued' },
          },
          {
            jobId: 'running-1',
            kind: 'auto',
            createdAt: '2026-10-09T00:02:00Z',
            request: '鳥',
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
