// @vitest-environment jsdom
import {
  createAutoJob,
  useBackendStatus,
  useCandidates,
  usePermissionSettings,
} from '@drawroid/swr';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoJobForm } from './auto-job-form';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  createAutoJob: vi.fn(),
  parseStopConditionsText: vi.fn(),
  usePermissionSettings: vi.fn(),
  useBackendStatus: vi.fn(),
  useCandidates: vi.fn(),
}));

const create = vi.mocked(createAutoJob);

beforeEach(() => {
  // jsdom には object URL が無い
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  // 全体の既定の許可。ジョブの許可の欄の「いま」に出す
  vi.mocked(usePermissionSettings).mockReturnValue({
    data: {
      overrides: {},
      permissions: {
        prompt: { mode: 'auto' },
        steps: { mode: 'auto' },
        cfgScale: { mode: 'auto' },
        width: { mode: 'fixed', value: 512 },
        height: { mode: 'fixed', value: 512 },
        vae: { mode: 'off' },
      },
    },
    error: undefined,
  } as unknown as ReturnType<typeof usePermissionSettings>);
  vi.mocked(useBackendStatus).mockReturnValue({
    data: { capabilities: { unavailable: [] } },
    error: undefined,
  } as unknown as ReturnType<typeof useBackendStatus>);
  vi.mocked(useCandidates).mockReturnValue({
    data: { candidates: [] },
    error: undefined,
  } as unknown as ReturnType<typeof useCandidates>);
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

  // 添えた画像の「外す」も指で押せる 44px にする（広い画面をマウスで操作するときだけ詰める）。実際の大きさは、ブラウザで測る
  it('makes the button that removes an attached image 44px tall on a narrow screen', async () => {
    render(<AutoJobForm onCreated={() => {}} />);
    const user = userEvent.setup();

    await user.upload(
      screen.getByLabelText(/参照画像を選ぶ/),
      new File([PNG_HEAD], 'ref.png', { type: 'image/png' }),
    );

    expect(screen.getByRole('button', { name: 'ref.png を外す' }).className.split(' ')).toEqual(
      expect.arrayContaining(['h-11', 'md:pointer-fine:h-7']),
    );
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

describe('AutoJobForm with permissions for this job only', () => {
  const created = { jobId: 'job-1' } as Awaited<ReturnType<typeof createAutoJob>>;

  async function openPermissions() {
    render(<AutoJobForm onCreated={() => {}} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/依頼/), '夕暮れの海');
    await user.click(screen.getByText('このジョブだけの許可'));
    return user;
  }

  it('shows the global default in effect for each parameter', async () => {
    await openPermissions();

    const width = within(screen.getByRole('row', { name: /^幅/ }));
    expect(width.getByText('固定: 512（全体の既定）')).toBeTruthy();
  });

  it('sends only the permissions changed for this job', async () => {
    create.mockResolvedValue(created);
    const user = await openPermissions();

    await user.selectOptions(screen.getByLabelText('steps の許可'), 'fixed');
    await user.type(screen.getByLabelText('steps の固定の値'), '30');
    await user.selectOptions(screen.getByLabelText('VAE の許可'), 'auto');
    await user.click(screen.getByRole('button', { name: '投入する' }));

    expect(create).toHaveBeenCalledWith({
      request: '夕暮れの海',
      stopConditions: { aiJudgement: true, maxIterations: 10 },
      batchSize: 1,
      permissions: { vae: { mode: 'auto' }, steps: { mode: 'fixed', value: 30 } },
    });
  });

  it('does not create the job when a permission for it is of the wrong shape', async () => {
    create.mockResolvedValue(created);
    const user = await openPermissions();

    await user.selectOptions(screen.getByLabelText('steps の許可'), 'fixed');
    await user.type(screen.getByLabelText('steps の固定の値'), '二十');
    await user.click(screen.getByRole('button', { name: '投入する' }));

    expect(create).not.toHaveBeenCalled();
    expect((await screen.findByText(/送れない/)).textContent).toContain('steps: 数を入れる');
  });
});
