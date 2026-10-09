// @vitest-environment jsdom
import { saveBackendSettings, useBackendSettings } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendUrlSettings } from './backend-url-settings';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  saveBackendSettings: vi.fn(),
  useBackendSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(useBackendSettings).mockReturnValue({
    data: { kind: 'forge', url: 'http://127.0.0.1:7860', urlSource: 'default' },
    error: undefined,
  } as never);
  vi.mocked(saveBackendSettings).mockResolvedValue({} as never);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('BackendUrlSettings', () => {
  // 保存すると欄は空に戻るので、知らせが無いと、押した人には効いたかが分からない
  it('says it saved the URL, since the field goes back to empty', async () => {
    const user = userEvent.setup();
    render(<BackendUrlSettings />);

    await user.type(screen.getByLabelText('バックエンドの URL'), 'http://127.0.0.1:7861');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(saveBackendSettings).toHaveBeenCalledWith({ url: 'http://127.0.0.1:7861' });
    expect(await screen.findByText('保存した。http://127.0.0.1:7861 に繋ぐ。')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('バックエンドの URL').value).toBe('');
  });

  it('takes the notice back once a new URL is being typed', async () => {
    const user = userEvent.setup();
    render(<BackendUrlSettings />);
    await user.type(screen.getByLabelText('バックエンドの URL'), 'http://127.0.0.1:7861');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText(/保存した/);

    await user.type(screen.getByLabelText('バックエンドの URL'), 'http://');

    expect(screen.queryByText(/保存した/)).toBeNull();
  });
});
