// @vitest-environment jsdom
import { ApiError } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationProgressSettings } from './generation-progress-settings';

const mocks = vi.hoisted(() => ({
  saveGenerationProgressSettings: vi.fn(),
  useGenerationProgressSettings: vi.fn(),
}));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  saveGenerationProgressSettings: mocks.saveGenerationProgressSettings,
  useGenerationProgressSettings: mocks.useGenerationProgressSettings,
}));

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.useGenerationProgressSettings.mockReturnValue({
    data: { includePreview: false },
    error: undefined,
  });
  mocks.saveGenerationProgressSettings.mockResolvedValue({ includePreview: true });
});

const box = () =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: '生成の途中の画像を出す' });

describe('GenerationProgressSettings', () => {
  it('shows the stored setting, off by default, with what turning it on costs', () => {
    render(<GenerationProgressSettings />);

    expect(box().checked).toBe(false);
    expect(screen.getByText(/1秒ごとに画像のバックエンドから途中の画像を取る/)).toBeTruthy();
  });

  it('saves as soon as it is turned on, and says when it takes effect', async () => {
    render(<GenerationProgressSettings />);

    await userEvent.setup().click(box());

    expect(mocks.saveGenerationProgressSettings).toHaveBeenCalledWith({ includePreview: true });
    expect(await screen.findByText('保存した。次に始まる生成から効く。')).toBeTruthy();
  });

  // 押した欄は送っている間押せなくなるので、フォーカスは保存した知らせへ移る。欄を触らない2回目の保存でも移る
  it('moves the focus to the note that it saved, also on a second save', async () => {
    const user = userEvent.setup();
    render(<GenerationProgressSettings />);
    const SAVED = '保存した。次に始まる生成から効く。';

    await user.click(box());
    const first = await screen.findByText(SAVED);
    expect(first.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(first);

    box().focus();
    expect(document.activeElement).toBe(box());
    await user.click(box());

    const second = await screen.findByText(SAVED);
    expect(document.activeElement).toBe(second);
  });

  it('saves off when it is turned off', async () => {
    mocks.useGenerationProgressSettings.mockReturnValue({
      data: { includePreview: true },
      error: undefined,
    });
    render(<GenerationProgressSettings />);

    await userEvent.setup().click(box());

    expect(mocks.saveGenerationProgressSettings).toHaveBeenCalledWith({ includePreview: false });
  });

  it('says why it could not be saved, and puts the box back', async () => {
    mocks.saveGenerationProgressSettings.mockRejectedValue(
      new ApiError('invalid_request', '形が違う', 400),
    );
    render(<GenerationProgressSettings />);

    await userEvent.setup().click(box());

    expect((await screen.findByRole('alert')).textContent).toContain('保存できない: 形が違う');
    // 保存できなければ、欄は読んだ値（off）に戻る
    expect(box().checked).toBe(false);
  });

  it('says why the setting could not be read', () => {
    mocks.useGenerationProgressSettings.mockReturnValue({
      data: undefined,
      error: new ApiError('invalid_config', 'config.json の generationProgress が不正', 500),
    });
    render(<GenerationProgressSettings />);

    expect(screen.getByRole('alert').textContent).toContain('設定を読めない');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
