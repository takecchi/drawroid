// @vitest-environment jsdom
import { createAutoJob } from '@drawroid/swr';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoJobForm } from './auto-job-form';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  createAutoJob: vi.fn(),
  parseStopConditionsText: vi.fn(),
}));

const create = vi.mocked(createAutoJob);

beforeEach(() => {
  // jsdom には object URL が無い
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function fillNeverStopping() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/依頼/), '夕暮れの海');
  await user.click(screen.getByLabelText(/AI が意図どおり/));
  await user.clear(screen.getByLabelText(/回数の上限/));
  return user;
}

describe('AutoJobForm', () => {
  it('sends the attached images as base64 with their notes', async () => {
    create.mockResolvedValue({ jobId: 'job-1' } as Awaited<ReturnType<typeof createAutoJob>>);
    render(<AutoJobForm onCreated={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/依頼/), '夕暮れの海');
    await user.upload(
      screen.getByLabelText(/参照画像を選ぶ/),
      new File([PNG_HEAD], 'ref.png', { type: 'image/png' }),
    );
    await user.type(screen.getByLabelText('用途の言葉（ref.png）'), ' この構図で ');
    await user.click(screen.getByRole('button', { name: '投入する' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        references: [{ mediaType: 'image/png', data: 'iVBORw==', note: 'この構図で' }],
      }),
    );
  });

  it('does not send an image of a refused type and shows the reason', async () => {
    create.mockResolvedValue({ jobId: 'job-1' } as Awaited<ReturnType<typeof createAutoJob>>);
    render(<AutoJobForm onCreated={() => {}} />);
    const user = userEvent.setup({ applyAccept: false });

    await user.type(screen.getByLabelText(/依頼/), '夕暮れの海');
    await user.upload(
      screen.getByLabelText(/参照画像を選ぶ/),
      new File([PNG_HEAD], 'ref.gif', { type: 'image/gif' }),
    );
    await user.click(screen.getByRole('button', { name: '投入する' }));

    expect((await screen.findByText(/添えられない/)).textContent).toContain('ref.gif');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('references');
  });

  it('does not send a removed image and revokes its preview URL', async () => {
    create.mockResolvedValue({ jobId: 'job-1' } as Awaited<ReturnType<typeof createAutoJob>>);
    render(<AutoJobForm onCreated={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/依頼/), '夕暮れの海');
    await user.upload(
      screen.getByLabelText(/参照画像を選ぶ/),
      new File([PNG_HEAD], 'ref.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: 'ref.png を外す' }));
    await user.click(screen.getByRole('button', { name: '投入する' }));

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('references');
  });

  it('does not create the job when a note is too long and shows the reason', async () => {
    render(<AutoJobForm onCreated={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/依頼/), '夕暮れの海');
    await user.upload(
      screen.getByLabelText(/参照画像を選ぶ/),
      new File([PNG_HEAD], 'ref.png', { type: 'image/png' }),
    );
    fireEvent.change(screen.getByLabelText('用途の言葉（ref.png）'), {
      target: { value: 'あ'.repeat(201) },
    });
    await user.click(screen.getByRole('button', { name: '投入する' }));

    expect(create).not.toHaveBeenCalled();
    expect((await screen.findByText(/送れない/)).textContent).toContain('200');
  });

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
