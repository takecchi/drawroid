// @vitest-environment jsdom
import { createAutoJob } from '@drawroid/swr';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutoJobForm } from './auto-job-form';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  createAutoJob: vi.fn(),
  parseStopConditionsText: vi.fn(),
}));

const create = vi.mocked(createAutoJob);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function fillNeverStopping() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/依頼/), '夕暮れの海');
  await user.click(screen.getByLabelText(/AI が意図どおり/));
  await user.clear(screen.getByLabelText(/回数の上限/));
  return user;
}

describe('AutoJobForm', () => {
  it('creates the job with the typed stop conditions', async () => {
    create.mockResolvedValue({ jobId: 'job-1' } as Awaited<ReturnType<typeof createAutoJob>>);
    const onCreated = vi.fn();
    render(<AutoJobForm onCreated={onCreated} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/依頼/), '夕暮れの海');
    await user.click(screen.getByRole('button', { name: '投入する' }));

    expect(create).toHaveBeenCalledWith({
      request: '夕暮れの海',
      stopConditions: { aiJudgement: true, maxIterations: 10 },
      batchSize: 1,
    });
    expect(onCreated).toHaveBeenCalledWith('job-1');
  });

  it('does not create a job that can never stop even when submitted without the button', async () => {
    render(<AutoJobForm onCreated={() => {}} />);
    await fillNeverStopping();

    const form = screen.getByRole('button', { name: '投入する' }).closest('form');
    fireEvent.submit(form as HTMLFormElement);

    expect(create).not.toHaveBeenCalled();
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(alerts.some((text) => text?.includes('送れない: この条件では止まらない'))).toBe(true);
  });
});
