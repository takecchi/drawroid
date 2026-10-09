// @vitest-environment jsdom
import {
  createAutoJob,
  useBackendStatus,
  useCandidates,
  usePermissionSettings,
} from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewJob from './new-job';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  createAutoJob: vi.fn(),
  parseStopConditionsText: vi.fn(),
  // 投入のフォームのジョブの許可の欄が読む。この試験では中身を見ない
  usePermissionSettings: vi.fn(),
  useBackendStatus: vi.fn(),
  useCandidates: vi.fn(),
}));

const create = vi.mocked(createAutoJob);

beforeEach(() => {
  const loaded = (data: unknown) => ({ data, error: undefined }) as never;
  vi.mocked(usePermissionSettings).mockReturnValue(loaded({ overrides: {}, permissions: {} }));
  vi.mocked(useBackendStatus).mockReturnValue(loaded({ capabilities: { unavailable: [] } }));
  vi.mocked(useCandidates).mockReturnValue(loaded({ candidates: [] }));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderScreen() {
  render(
    <MemoryRouter initialEntries={['/jobs/new']}>
      <Routes>
        <Route path="/jobs/new" element={<NewJob />} />
        <Route path="/jobs/:jobId" element={<p>ジョブ詳細の画面</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const submitButton = () => screen.getByRole('button', { name: '投入する' });
const requestBox = () => screen.getByLabelText(/依頼/);

describe('new job screen', () => {
  it('does not let the job be submitted while the conditions would never stop it', async () => {
    const user = renderScreen();
    await user.type(requestBox(), '夕暮れの海');
    await user.click(screen.getByLabelText(/AI が意図どおり/));
    await user.clear(screen.getByLabelText(/回数の上限/));

    expect(submitButton()).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toContain('この条件では止まらない');
    await user.click(submitButton());
    expect(create).not.toHaveBeenCalled();
  });

  it('does not let an empty request be submitted', () => {
    renderScreen();

    expect(submitButton()).toHaveProperty('disabled', true);
  });

  it('creates the job with the typed request and conditions, then moves to its detail', async () => {
    create.mockResolvedValue({ jobId: 'job-42' } as Awaited<ReturnType<typeof createAutoJob>>);
    const user = renderScreen();

    await user.type(requestBox(), '夕暮れの海');
    await user.click(screen.getByLabelText(/AI が意図どおり/));
    await user.clear(screen.getByLabelText(/回数の上限/));
    await user.type(screen.getByLabelText(/回数の上限/), '4');
    await user.type(screen.getByLabelText(/時間の上限/), '2');
    await user.clear(screen.getByLabelText(/1回の枚数/));
    await user.type(screen.getByLabelText(/1回の枚数/), '3');
    await user.click(submitButton());

    expect(create).toHaveBeenCalledWith({
      request: '夕暮れの海',
      stopConditions: { aiJudgement: false, maxIterations: 4, maxDurationMs: 120_000 },
      batchSize: 3,
    });
    expect(await screen.findByText('ジョブ詳細の画面')).toBeTruthy();
  });

  it('submits with the default conditions (AI judgement and 10 iterations)', async () => {
    create.mockResolvedValue({ jobId: 'job-1' } as Awaited<ReturnType<typeof createAutoJob>>);
    const user = renderScreen();

    await user.type(requestBox(), '猫');
    await user.click(submitButton());

    expect(create).toHaveBeenCalledWith({
      request: '猫',
      stopConditions: { aiJudgement: true, maxIterations: 10 },
      batchSize: 1,
    });
  });

  it('shows the reason and stays on the screen when the API answers 400', async () => {
    const { ApiError } = await vi.importActual<typeof import('@drawroid/swr')>('@drawroid/swr');
    create.mockRejectedValue(new ApiError('invalid_request', '依頼が長すぎる', 400));
    const user = renderScreen();

    await user.type(requestBox(), '猫');
    await user.click(submitButton());

    const alert = await screen.findByText(/送れない/);
    expect(alert.textContent).toContain('依頼が長すぎる');
    expect(screen.queryByText('ジョブ詳細の画面')).toBeNull();
  });
});
