// @vitest-environment jsdom
import {
  addInstruction,
  changeStopConditions,
  stopJob,
  type JobDetail,
  type ChangeStopConditionsResponse,
} from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobOperations } from './job-operations';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  stopJob: vi.fn(),
  addInstruction: vi.fn(),
  changeStopConditions: vi.fn(),
  parseStopConditionsText: vi.fn(),
}));

const stop = vi.mocked(stopJob);
const instruct = vi.mocked(addInstruction);
const change = vi.mocked(changeStopConditions);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const autoSpec = {
  kind: 'auto',
  jobId: 'job-7',
  createdAt: '2026-01-01T00:00:00.000Z',
  request: '夕暮れの海',
  stopConditions: { aiJudgement: true, maxIterations: 10 },
  batchSize: 1,
};

function runningAuto(): JobDetail {
  return {
    spec: autoSpec,
    state: { status: 'running', startedAt: '2026-01-01T00:00:01.000Z', imagesGenerated: 0 },
  } as unknown as JobDetail;
}

function stoppedAuto(): JobDetail {
  return {
    spec: autoSpec,
    state: {
      status: 'stopped',
      stoppedAt: '2026-01-01T00:01:00.000Z',
      imagesGenerated: 2,
      reason: { kind: 'human', detail: '人が止めた' },
    },
  } as unknown as JobDetail;
}

function manualJob(): JobDetail {
  return {
    spec: {
      kind: 'manual',
      jobId: 'job-m',
      createdAt: '2026-01-01T00:00:00.000Z',
      request: { prompt: 'cat' },
    },
    state: { status: 'running', startedAt: '2026-01-01T00:00:01.000Z', imagesGenerated: 0 },
  } as unknown as JobDetail;
}

async function apiError(kind: string, message: string, status: number) {
  const { ApiError } = await vi.importActual<typeof import('@drawroid/swr')>('@drawroid/swr');
  return new ApiError(kind, message, status);
}

describe('JobOperations', () => {
  it('shows no operations for a stopped job', () => {
    render(<JobOperations job={stoppedAuto()} />);

    expect(screen.queryByRole('heading', { name: '操作' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows no operations for a manual job', () => {
    render(<JobOperations job={manualJob()} />);

    expect(screen.queryByRole('heading', { name: '操作' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the operations for a running auto job', () => {
    render(<JobOperations job={runningAuto()} />);

    expect(screen.getByRole('heading', { name: '操作' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ジョブを止める' })).toBeTruthy();
  });

  describe('stopping', () => {
    it('stops the job after the user confirms', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      stop.mockResolvedValue(undefined);
      render(<JobOperations job={runningAuto()} />);

      await userEvent.setup().click(screen.getByRole('button', { name: 'ジョブを止める' }));

      expect(stop).toHaveBeenCalledWith('job-7');
    });

    it('does not stop the job when the user cancels the confirmation', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<JobOperations job={runningAuto()} />);

      await userEvent.setup().click(screen.getByRole('button', { name: 'ジョブを止める' }));

      expect(stop).not.toHaveBeenCalled();
    });

    it('shows the reason when the job cannot be stopped', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      stop.mockRejectedValue(await apiError('conflict', 'もう止まっている', 409));
      render(<JobOperations job={runningAuto()} />);

      await userEvent.setup().click(screen.getByRole('button', { name: 'ジョブを止める' }));

      expect((await screen.findByText(/止められない/)).textContent).toContain('もう止まっている');
    });
  });

  describe('instruction', () => {
    it('keeps the send button disabled while the text is blank', () => {
      render(<JobOperations job={runningAuto()} />);

      expect(screen.getByRole('button', { name: '送る' })).toHaveProperty('disabled', true);
    });

    it('sends the typed instruction to the job and clears the box', async () => {
      instruct.mockResolvedValue({} as Awaited<ReturnType<typeof addInstruction>>);
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.type(screen.getByLabelText('人間の指示'), 'もっと明るく');
      await user.click(screen.getByRole('button', { name: '送る' }));

      expect(instruct).toHaveBeenCalledWith('job-7', 'もっと明るく');
      expect(await screen.findByText(/送った/)).toBeTruthy();
      expect(screen.getByLabelText('人間の指示')).toHaveProperty('value', '');
    });

    it('shows the reason and keeps the text when the API answers 409', async () => {
      instruct.mockRejectedValue(await apiError('conflict', '止まったジョブには送れない', 409));
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.type(screen.getByLabelText('人間の指示'), 'もっと明るく');
      await user.click(screen.getByRole('button', { name: '送る' }));

      expect((await screen.findByText(/送れない/)).textContent).toContain(
        '止まったジョブには送れない',
      );
      expect(screen.getByLabelText('人間の指示')).toHaveProperty('value', 'もっと明るく');
    });
  });

  describe('changing the stop conditions', () => {
    it('starts from the conditions the job was submitted with', () => {
      render(<JobOperations job={runningAuto()} />);

      expect(screen.getByLabelText(/回数の上限/)).toHaveProperty('value', '10');
      expect(screen.getByLabelText(/AI が意図どおり/)).toHaveProperty('checked', true);
    });

    it('sends every field, removing limits that were cleared, and shows the effective conditions', async () => {
      change.mockResolvedValue({
        stopConditions: { aiJudgement: false, maxImages: 6, maxDurationMs: 300_000 },
      } as ChangeStopConditionsResponse);
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.click(screen.getByLabelText(/AI が意図どおり/));
      await user.clear(screen.getByLabelText(/回数の上限/));
      await user.type(screen.getByLabelText(/枚数の上限/), '6');
      await user.type(screen.getByLabelText(/時間の上限/), '5');
      await user.click(screen.getByRole('button', { name: '条件を変える' }));

      expect(change).toHaveBeenCalledWith('job-7', {
        aiJudgement: false,
        maxIterations: null,
        maxImages: 6,
        maxDurationMs: 300_000,
      });
      expect(await screen.findByText('6 枚まで')).toBeTruthy();
      expect(screen.getByText('5 分まで')).toBeTruthy();
      expect(screen.queryByText('10 回まで')).toBeNull();
    });

    it('does not call the API while the conditions would never stop the job', async () => {
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.click(screen.getByLabelText(/AI が意図どおり/));
      await user.clear(screen.getByLabelText(/回数の上限/));

      expect(screen.getByRole('button', { name: '条件を変える' })).toHaveProperty('disabled', true);
      expect(change).not.toHaveBeenCalled();
    });

    it('shows the reason when the API answers 409', async () => {
      change.mockRejectedValue(await apiError('conflict', 'もう止まっている', 409));
      render(<JobOperations job={runningAuto()} />);

      await userEvent.setup().click(screen.getByRole('button', { name: '条件を変える' }));

      expect((await screen.findByText(/変えられない/)).textContent).toContain('もう止まっている');
    });
  });
});
