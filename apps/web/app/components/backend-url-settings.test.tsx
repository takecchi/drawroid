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
  const field = () => screen.getByLabelText<HTMLInputElement>('バックエンドの URL');

  it('starts the field with the URL it is connected to now, not an empty field', () => {
    vi.mocked(useBackendSettings).mockReturnValue({
      data: { kind: 'forge', url: 'http://127.0.0.1:35267', urlSource: 'config' },
      error: undefined,
    } as never);
    render(<BackendUrlSettings />);

    expect(field().value).toBe('http://127.0.0.1:35267');
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false);
  });

  it('keeps the warning that the start-up argument wins next time, with the URL in the field', () => {
    vi.mocked(useBackendSettings).mockReturnValue({
      data: { kind: 'forge', url: 'http://gpu:7860', urlSource: 'cli' },
      error: undefined,
    } as never);
    render(<BackendUrlSettings />);

    expect(field().value).toBe('http://gpu:7860');
    expect(screen.getByText(/次に起動したときも同じ引数を付ければ、そちらが勝つ/)).toBeTruthy();
  });

  // 保存しても欄の見た目は変わらないので、知らせが無いと、押した人には効いたかが分からない
  it('says it saved the URL, and shows the URL it is connected to in the field', async () => {
    const user = userEvent.setup();
    vi.mocked(saveBackendSettings).mockImplementation(async ({ url }) => {
      vi.mocked(useBackendSettings).mockReturnValue({
        data: { kind: 'forge', url, urlSource: 'config' },
        error: undefined,
      } as never);
      return {} as never;
    });
    render(<BackendUrlSettings />);

    await user.clear(field());
    await user.type(field(), 'http://127.0.0.1:7861');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(saveBackendSettings).toHaveBeenCalledWith({ url: 'http://127.0.0.1:7861' });
    expect(await screen.findByText('保存した。http://127.0.0.1:7861 に繋ぐ。')).toBeTruthy();
    expect(field().value).toBe('http://127.0.0.1:7861');
  });

  it('cannot save an emptied field', async () => {
    const user = userEvent.setup();
    render(<BackendUrlSettings />);

    await user.clear(field());

    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
  });

  it('takes the notice back once a new URL is being typed', async () => {
    const user = userEvent.setup();
    render(<BackendUrlSettings />);
    await user.clear(field());
    await user.type(screen.getByLabelText('バックエンドの URL'), 'http://127.0.0.1:7861');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText(/保存した/);

    await user.type(screen.getByLabelText('バックエンドの URL'), 'http://');

    expect(screen.queryByText(/保存した/)).toBeNull();
  });
});
