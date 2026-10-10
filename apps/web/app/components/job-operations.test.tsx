// @vitest-environment jsdom
import type { StopConditions } from '@drawroid/core';
import {
  addInstruction,
  addReference,
  changeStopConditions,
  stopJob,
  stopManualJob,
  useStopConditions,
  type JobDetail,
  type ChangeStopConditionsResponse,
} from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobOperations } from './job-operations';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  stopJob: vi.fn(),
  stopManualJob: vi.fn(),
  addInstruction: vi.fn(),
  addReference: vi.fn(),
  changeStopConditions: vi.fn(),
  parseStopConditionsText: vi.fn(),
  useStopConditions: vi.fn(),
}));

const stop = vi.mocked(stopJob);
const instruct = vi.mocked(addInstruction);
const reference = vi.mocked(addReference);
const stopConditionsHook = vi.mocked(useStopConditions);

// 取り直し（mutate）の結果は、フックが次に返す値で表す: 本物の SWR を通さずに「取り直した current が入る」ことを見るため
let served: { submitted: StopConditions; current: StopConditions };
function serve(next: typeof served) {
  served = next;
}
const change = vi.mocked(changeStopConditions);

beforeEach(() => {
  serve({ submitted: autoSpec.stopConditions, current: autoSpec.stopConditions });
  stopConditionsHook.mockImplementation(
    () => ({ data: served }) as unknown as ReturnType<typeof useStopConditions>,
  );
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

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

  // 手動の生成は口出しを受けないので、止めるだけを出す
  it('shows only the stop for a manual job that has not stopped, and stops it through the manual stop', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(stopManualJob).mockResolvedValue(undefined);
    render(<JobOperations job={manualJob()} />);

    expect(screen.getByRole('heading', { name: '操作' })).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'ジョブを止める',
    ]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'ジョブを止める' }));

    expect(stopManualJob).toHaveBeenCalledWith('job-m');
    expect(stop).not.toHaveBeenCalled();
  });

  it('shows no operations for a manual job that has stopped', () => {
    const job = manualJob();
    render(<JobOperations job={{ ...job, state: stoppedAuto().state }} />);

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

  describe('reference images', () => {
    const png = () =>
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'ref.png', { type: 'image/png' });

    it('sends each attached image to the job one at a time and says when it is looked at', async () => {
      reference.mockResolvedValue({} as Awaited<ReturnType<typeof addReference>>);
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.upload(screen.getByLabelText(/参照画像を選ぶ/), [png(), png()]);
      await user.click(screen.getByRole('button', { name: '参照画像を送る' }));

      expect(reference).toHaveBeenCalledTimes(2);
      expect(reference).toHaveBeenCalledWith('job-7', { mediaType: 'image/png', data: 'iVBORw==' });
      expect((await screen.findByText(/2 枚送った/)).textContent).toContain(
        '次の回の境目で見る役が1度だけ見て要点にする',
      );
    });

    it('shows the reason and keeps the image when the API answers 409', async () => {
      reference.mockRejectedValue(await apiError('conflict', '止まったジョブには送れない', 409));
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.upload(screen.getByLabelText(/参照画像を選ぶ/), png());
      await user.click(screen.getByRole('button', { name: '参照画像を送る' }));

      expect((await screen.findByText(/送れない/)).textContent).toContain(
        '止まったジョブには送れない',
      );
      expect(screen.getByRole('button', { name: 'ref.png を外す' })).toBeTruthy();
    });

    it('shows the reason when the API answers 400', async () => {
      reference.mockRejectedValue(
        await apiError('invalid_request', 'image/png の画像ではない', 400),
      );
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.upload(screen.getByLabelText(/参照画像を選ぶ/), png());
      await user.click(screen.getByRole('button', { name: '参照画像を送る' }));

      expect((await screen.findByText(/送れない/)).textContent).toContain('画像ではない');
    });

    it('does not call the API for an image of a refused type', async () => {
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup({ applyAccept: false });

      await user.upload(
        screen.getByLabelText(/参照画像を選ぶ/),
        new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' }),
      );

      expect((await screen.findByText(/添えられない/)).textContent).toContain('a.gif');
      expect(screen.getByRole('button', { name: '参照画像を送る' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(reference).not.toHaveBeenCalled();
    });
  });

  describe('changing the stop conditions', () => {
    it('starts from the current conditions, not the ones the job was submitted with', () => {
      serve({
        submitted: { aiJudgement: true, maxIterations: 10 },
        current: { aiJudgement: false, maxImages: 6 },
      });
      render(<JobOperations job={runningAuto()} />);

      expect(screen.getByLabelText(/AI が意図どおり/)).toHaveProperty('checked', false);
      expect(screen.getByLabelText(/回数の上限/)).toHaveProperty('value', '');
      expect(screen.getByLabelText(/枚数の上限/)).toHaveProperty('value', '6');
    });

    it('shows no change notice while the current conditions equal the submitted ones', () => {
      render(<JobOperations job={runningAuto()} />);

      expect(screen.queryByText('投入時から変わった')).toBeNull();
    });

    it('shows both the submitted and the current value of each field that changed', () => {
      serve({
        submitted: { aiJudgement: true, maxIterations: 10 },
        current: { aiJudgement: true, maxIterations: 4, maxDurationMs: 300_000 },
      });
      render(<JobOperations job={runningAuto()} />);

      expect(screen.getByText('投入時から変わった')).toBeTruthy();
      expect(screen.getByText('回数の上限: 投入時 10 回 → いま 4 回')).toBeTruthy();
      expect(screen.getByText('時間の上限: 投入時 なし → いま 5 分')).toBeTruthy();
      expect(screen.queryByText(/AI の判断:/)).toBeNull();
    });

    it('sends only the field the user changed, so a field another tab changed is not put back', async () => {
      const { rerender } = render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.type(screen.getByLabelText(/枚数の上限/), '6');
      // 別のタブが、回数の上限を 10 回 → 4 回に変えた（ポーリングで取り直した current に入る）
      serve({
        submitted: autoSpec.stopConditions,
        current: { aiJudgement: true, maxIterations: 4 },
      });
      rerender(<JobOperations job={runningAuto()} />);

      expect(screen.getByLabelText(/回数の上限/)).toHaveProperty('value', '4');
      expect(screen.getByLabelText(/枚数の上限/)).toHaveProperty('value', '6');
      await user.click(screen.getByRole('button', { name: '条件を変える' }));

      expect(change).toHaveBeenCalledWith('job-7', { maxImages: 6 });
    });

    it('removes only the limit the user cleared', async () => {
      render(<JobOperations job={runningAuto()} />);
      const user = userEvent.setup();

      await user.clear(screen.getByLabelText(/回数の上限/));
      await user.type(screen.getByLabelText(/枚数の上限/), '6');
      await user.click(screen.getByRole('button', { name: '条件を変える' }));

      expect(change).toHaveBeenCalledWith('job-7', { maxIterations: null, maxImages: 6 });
    });

    it('keeps the change button disabled while no field has been changed', () => {
      render(<JobOperations job={runningAuto()} />);

      expect(screen.getByRole('button', { name: '条件を変える' })).toHaveProperty('disabled', true);
    });

    it('sends every field the user changed, removing limits that were cleared, and fills in the refetched current conditions', async () => {
      change.mockImplementation(async () => {
        serve({
          submitted: autoSpec.stopConditions,
          current: { aiJudgement: false, maxImages: 6, maxDurationMs: 300_000 },
        });
        return {} as ChangeStopConditionsResponse;
      });
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
      expect(screen.getByLabelText(/枚数の上限/)).toHaveProperty('value', '6');
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
      const user = userEvent.setup();

      await user.type(screen.getByLabelText(/枚数の上限/), '6');
      await user.click(screen.getByRole('button', { name: '条件を変える' }));

      expect((await screen.findByText(/変えられない/)).textContent).toContain('もう止まっている');
    });
  });
});
