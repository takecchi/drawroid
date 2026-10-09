// @vitest-environment jsdom
import { ApiError, saveBackendSettings, useBackendSettings } from '@drawroid/swr';
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
  // 「保存した」だけで探さない: 引数で決まっているときの注意書き（「ここで保存した URL は…」）にも当たり、知らせの有無を見誤るため
  const savedNotice = /^保存した。.+ に繋ぐ。$/;

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
    await screen.findByText(savedNotice);

    await user.type(screen.getByLabelText('バックエンドの URL'), 'http://');

    expect(screen.queryByText(savedNotice)).toBeNull();
  });

  // 欠けた形や {} で流さない: 本番の API が返す view（保存は urlSource 'config'）でしか起きない崩れを見落とすため
  const view = (url: string, urlSource: 'cli' | 'config' | 'default') =>
    ({ kind: 'forge', url, urlSource, auth: null, generateTimeoutMs: null }) as const;
  const saveButton = () => screen.getByRole('button', { name: '保存' });

  it('saves the URL without the spaces around it, and says the trimmed URL', async () => {
    const user = userEvent.setup();
    vi.mocked(saveBackendSettings).mockResolvedValue(view('http://127.0.0.1:7861', 'config'));
    render(<BackendUrlSettings />);

    await user.clear(field());
    await user.type(field(), '  http://127.0.0.1:7861  ');
    await user.click(saveButton());

    expect(saveBackendSettings).toHaveBeenCalledWith({ url: 'http://127.0.0.1:7861' });
    expect(await screen.findByText('保存した。http://127.0.0.1:7861 に繋ぐ。')).toBeTruthy();
  });

  it('cannot save a field of only spaces', async () => {
    const user = userEvent.setup();
    render(<BackendUrlSettings />);

    await user.clear(field());
    await user.type(field(), '   ');

    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('can save again after a save, not left waiting', async () => {
    const user = userEvent.setup();
    vi.mocked(saveBackendSettings).mockResolvedValue(view('http://127.0.0.1:7861', 'config'));
    render(<BackendUrlSettings />);
    await user.clear(field());
    await user.type(field(), 'http://127.0.0.1:7861');

    await user.click(saveButton());
    await screen.findByText(savedNotice);

    expect(saveButton()).toHaveProperty('disabled', false);
  });

  describe('when the save fails', () => {
    const busy = '生成が走っているあいだは繋ぎ直せない。生成が終わるか、止めてからやり直す';
    const failSave = () =>
      vi.mocked(saveBackendSettings).mockRejectedValue(new ApiError('busy', busy, 409));

    it('shows why, does not say it saved, and keeps what was typed', async () => {
      const user = userEvent.setup();
      failSave();
      render(<BackendUrlSettings />);
      await user.clear(field());
      await user.type(field(), 'http://127.0.0.1:7861');

      await user.click(saveButton());

      expect(await screen.findByText(`保存できない: ${busy}`)).toBeTruthy();
      expect(screen.queryByText(savedNotice)).toBeNull();
      expect(field().value).toBe('http://127.0.0.1:7861');
    });

    it('can be tried again, not left waiting', async () => {
      const user = userEvent.setup();
      failSave();
      render(<BackendUrlSettings />);
      await user.type(field(), '1');

      await user.click(saveButton());
      await screen.findByText(/保存できない/);

      expect(saveButton()).toHaveProperty('disabled', false);
    });
  });

  // SWR は再取得のたびに別の data オブジェクトを返す。打っている途中の値を、読み直した設定で上書きしない
  it('keeps what is being typed when the settings are read again', async () => {
    const user = userEvent.setup();
    vi.mocked(useBackendSettings).mockReturnValue({
      data: view('http://127.0.0.1:7860', 'default'),
      error: undefined,
    } as never);
    const { rerender } = render(<BackendUrlSettings />);
    await user.clear(field());
    await user.type(field(), 'http://127.0.0.1:7861');

    vi.mocked(useBackendSettings).mockReturnValue({
      data: view('http://127.0.0.1:7860', 'default'),
      error: undefined,
    } as never);
    rerender(<BackendUrlSettings />);

    expect(field().value).toBe('http://127.0.0.1:7861');
  });

  it('does not show the start-up argument warning when the URL comes from config or the default', () => {
    for (const urlSource of ['config', 'default'] as const) {
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://127.0.0.1:7860', urlSource),
        error: undefined,
      } as never);
      const { unmount } = render(<BackendUrlSettings />);

      expect(screen.queryByText(/注意: 起動時に --backend-url/)).toBeNull();
      unmount();
    }
  });

  // 引数で決まっていても、保存は今の起動の間は効く。同じ URL を押せなくすると、config.json へ書く手段が無くなる
  it('can save the same URL as the start-up argument, as it is', async () => {
    const user = userEvent.setup();
    vi.mocked(useBackendSettings).mockReturnValue({
      data: view('http://gpu:7860', 'cli'),
      error: undefined,
    } as never);
    vi.mocked(saveBackendSettings).mockResolvedValue(view('http://gpu:7860', 'config'));
    render(<BackendUrlSettings />);

    expect(saveButton()).toHaveProperty('disabled', false);
    await user.click(saveButton());

    expect(saveBackendSettings).toHaveBeenCalledWith({ url: 'http://gpu:7860' });
  });
});
