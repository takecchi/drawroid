// @vitest-environment jsdom
import { ApiError, type PermissionSettingsResponse } from '@drawroid/swr';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionSettings } from './permission-settings';

const mocks = vi.hoisted(() => ({
  usePermissionSettings: vi.fn(),
  savePermissionSettings: vi.fn(),
  useBackendStatus: vi.fn(),
  useCandidates: vi.fn(),
}));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  ...mocks,
}));

afterEach(cleanup);

const auto = { mode: 'auto' } as const;
const off = { mode: 'off' } as const;
const stored = {
  overrides: { steps: { mode: 'fixed', value: 28 } },
  permissions: {
    prompt: auto,
    negativePrompt: auto,
    checkpoint: off,
    vae: off,
    loras: off,
    sampler: off,
    scheduler: off,
    steps: { mode: 'fixed', value: 28 },
    cfgScale: auto,
    seed: auto,
    width: { mode: 'fixed', value: 512 },
    height: { mode: 'fixed', value: 512 },
    hiresFix: off,
    img2img: off,
    inpaint: off,
    controlnet: off,
  },
} as unknown as PermissionSettingsResponse;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.usePermissionSettings.mockReturnValue({ data: stored, error: undefined });
  mocks.savePermissionSettings.mockResolvedValue(stored);
  mocks.useBackendStatus.mockReturnValue({
    data: {
      capabilities: { unavailable: [{ feature: 'controlnet', reason: '拡張が入っていない' }] },
    },
    error: undefined,
  });
  mocks.useCandidates.mockImplementation((kind: string) => ({
    data: {
      candidates:
        kind === 'checkpoint' ? [{ name: 'anime.safetensors' }, { name: 'real.safetensors' }] : [],
    },
    error: undefined,
  }));
});

const rowOf = (label: string) => within(screen.getByRole('row', { name: new RegExp(`^${label}`) }));
const save = () => userEvent.click(screen.getByRole('button', { name: '許可を保存' }));

describe('PermissionSettings', () => {
  it('shows the permission in effect for each parameter, and which ones were written', () => {
    render(<PermissionSettings />);

    expect(rowOf('steps').getByText('固定: 28')).toBeTruthy();
    expect(rowOf('steps').getByRole<HTMLSelectElement>('combobox').value).toBe('fixed');
    expect(rowOf('幅').getByText('固定: 512（既定）')).toBeTruthy();
    expect(rowOf('幅').getByRole<HTMLSelectElement>('combobox').value).toBe('default');
  });

  it('does not offer to turn off a parameter every generation needs', () => {
    render(<PermissionSettings />);

    const off = (label: string) =>
      rowOf(label).getByRole<HTMLOptionElement>('option', { name: '使わない' }).disabled;
    expect(off('プロンプト')).toBe(true);
    expect(off('VAE')).toBe(false);
  });

  it('says why the backend cannot use a feature, and when inpaint is offered', () => {
    render(<PermissionSettings />);

    expect(rowOf('ControlNet').getByText(/拡張が入っていない/)).toBeTruthy();
    expect(rowOf('inpaint').getByText(/マスクを塗った回だけ/)).toBeTruthy();
  });

  it('lets the AI choose a checkpoint only from the ones picked', async () => {
    render(<PermissionSettings />);

    await userEvent.selectOptions(rowOf('checkpoint').getByRole('combobox'), 'auto');
    await userEvent.click(rowOf('checkpoint').getByLabelText('候補を絞る'));
    await userEvent.click(rowOf('checkpoint').getByLabelText('anime.safetensors'));
    await save();

    expect(mocks.savePermissionSettings).toHaveBeenCalledWith({
      steps: { mode: 'fixed', value: 28 },
      checkpoint: { mode: 'auto', choices: ['anime.safetensors'] },
    });
  });

  it('saves a fixed value and puts a row back to the default', async () => {
    render(<PermissionSettings />);

    await userEvent.selectOptions(rowOf('CFG scale').getByRole('combobox'), 'fixed');
    await userEvent.type(rowOf('CFG scale').getByLabelText('CFG scale の固定の値'), '6.5');
    await userEvent.selectOptions(rowOf('steps').getByRole('combobox'), 'default');
    await save();

    expect(mocks.savePermissionSettings).toHaveBeenCalledWith({
      cfgScale: { mode: 'fixed', value: 6.5 },
    });
  });

  it('does not save a fixed value of the wrong shape, and says which parameter it was', async () => {
    render(<PermissionSettings />);

    await userEvent.clear(rowOf('steps').getByLabelText('steps の固定の値'));
    await userEvent.type(rowOf('steps').getByLabelText('steps の固定の値'), '二十');
    await save();

    expect(mocks.savePermissionSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('steps: 数を入れる');
  });

  // 押した保存は送っている間押せなくなるので、フォーカスは保存した知らせへ移る。欄を触らない2回目の保存でも移る
  it('moves the focus to the note that it saved, also on a second save', async () => {
    render(<PermissionSettings />);
    const SAVED = '保存した。走行中のジョブにも次の回から効く。';

    await save();
    const first = await screen.findByText(SAVED);
    expect(first.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(first);

    screen.getByRole('button', { name: '許可を保存' }).focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '許可を保存' }));
    await save();

    const second = await screen.findByText(SAVED);
    expect(document.activeElement).toBe(second);
  });

  it('shows why the API refused the permissions', async () => {
    mocks.savePermissionSettings.mockRejectedValue(
      new ApiError('invalid_request', 'vae: 形が違う', 400),
    );
    render(<PermissionSettings />);

    await save();

    expect((await screen.findByRole('alert')).textContent).toContain('vae: 形が違う');
  });

  it('marks the rows that could not be read as falling back to the default, with why', () => {
    mocks.usePermissionSettings.mockReturnValue({
      data: {
        ...stored,
        invalid: [
          { param: 'cfgScale', reason: 'value: 数ではない' },
          { param: 'denoise', reason: '知らないパラメータ' },
        ],
      },
      error: undefined,
    });
    render(<PermissionSettings />);

    expect(rowOf('CFG scale').getByText(/無効（既定に戻る）: value: 数ではない/)).toBeTruthy();
    const others = screen.getByText(/読めない許可がある/).textContent;
    expect(others).toContain('denoise（知らないパラメータ）');
    expect(others).toContain('保存すると');
  });

  it('says the stored permissions cannot be read', () => {
    mocks.usePermissionSettings.mockReturnValue({
      data: undefined,
      error: new ApiError('invalid_config', 'steps.mode: 違う', 500),
    });
    render(<PermissionSettings />);

    expect(screen.getByRole('alert').textContent).toContain('steps.mode: 違う');
  });
});
