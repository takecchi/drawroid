// @vitest-environment jsdom
import { ApiError, saveBackendSettings, useBackendSettings } from '@drawroid/swr';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    data: {
      kind: 'forge',
      url: 'http://127.0.0.1:7860',
      urlSource: 'default',
      kindSource: 'default',
      startupArgs: { kind: false, url: false },
    },
    error: undefined,
  } as never);
  vi.mocked(saveBackendSettings).mockResolvedValue({} as never);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// 文が見えたすぐあとに確かめない: フォーカスを移すのは描いたあとの effect で、act の外で結果が届くと、
// findBy* が文を見つけた時点ではまだ走っていないことがある
const expectFocusMovesTo = (element: Element) =>
  waitFor(() => expect(document.activeElement).toBe(element));

describe('BackendUrlSettings', () => {
  const field = () => screen.getByLabelText<HTMLInputElement>('バックエンドの URL');
  // 「保存した」だけで探さない: 引数で決まっているときの注意書き（「ここで保存した URL は…」）にも当たり、知らせの有無を見誤るため
  const savedNotice = /^保存した。.+ に繋ぐ。$/;

  it('starts the field with the URL it is connected to now, not an empty field', () => {
    vi.mocked(useBackendSettings).mockReturnValue({
      data: {
        kind: 'forge',
        url: 'http://127.0.0.1:35267',
        urlSource: 'config',
        startupArgs: { kind: false, url: false },
      },
      error: undefined,
    } as never);
    render(<BackendUrlSettings />);

    expect(field().value).toBe('http://127.0.0.1:35267');
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false);
  });

  it('keeps the warning that the start-up argument wins next time, with the URL in the field', () => {
    vi.mocked(useBackendSettings).mockReturnValue({
      data: {
        kind: 'forge',
        url: 'http://gpu:7860',
        urlSource: 'cli',
        startupArgs: { kind: false, url: true },
      },
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
        data: {
          kind: 'forge',
          url,
          urlSource: 'config',
          kindSource: 'config',
          startupArgs: { kind: false, url: false },
        },
        error: undefined,
      } as never);
      return {} as never;
    });
    render(<BackendUrlSettings />);

    await user.clear(field());
    await user.type(field(), 'http://127.0.0.1:7861');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(saveBackendSettings).toHaveBeenCalledWith({ url: 'http://127.0.0.1:7861' });
    expect(
      await screen.findByText('保存した。Forge の http://127.0.0.1:7861 に繋ぐ。'),
    ).toBeTruthy();
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
  const view = (
    url: string,
    urlSource: 'cli' | 'config' | 'default',
    kind: 'forge' | 'a1111' = 'forge',
    kindSource: 'cli' | 'config' | 'default' = urlSource,
    // 既定は出どころが 'cli' かどうか。出どころと食い違う組（保存のあと）を見る試験だけが渡す
    startupArgs = { kind: kindSource === 'cli', url: urlSource === 'cli' },
  ) =>
    ({
      kind,
      url,
      urlSource,
      kindSource,
      startupArgs,
      auth: null,
      generateTimeoutMs: null,
    }) as const;
  const saveButton = () => screen.getByRole('button', { name: '保存' });

  it('saves the URL without the spaces around it, and says the trimmed URL', async () => {
    const user = userEvent.setup();
    vi.mocked(saveBackendSettings).mockResolvedValue(view('http://127.0.0.1:7861', 'config'));
    render(<BackendUrlSettings />);

    await user.clear(field());
    await user.type(field(), '  http://127.0.0.1:7861  ');
    await user.click(saveButton());

    expect(saveBackendSettings).toHaveBeenCalledWith({ url: 'http://127.0.0.1:7861' });
    // findByText は空白を畳んで比べるので、知らせの文字そのものを見る
    expect((await screen.findByText(savedNotice)).textContent).toBe(
      '保存した。Forge の http://127.0.0.1:7861 に繋ぐ。',
    );
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

  it('cannot be saved again while saving', async () => {
    const user = userEvent.setup();
    vi.mocked(saveBackendSettings).mockReturnValue(new Promise(() => undefined));
    render(<BackendUrlSettings />);

    await user.click(saveButton());

    expect(saveBackendSettings).toHaveBeenCalledTimes(1);
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  // 押した保存は送っている間押せなくなるので、フォーカスは保存した知らせへ移る（読み上げは移った先を読む）
  it('moves the focus to the note that it saved, also on a second save without editing', async () => {
    const user = userEvent.setup();
    render(<BackendUrlSettings />);

    saveButton().focus();
    await user.keyboard('{Enter}');
    const first = await screen.findByText(savedNotice);
    expect(first.getAttribute('role')).toBe('status');
    await expectFocusMovesTo(first);

    saveButton().focus();
    expect(document.activeElement).toBe(saveButton());
    await user.keyboard('{Enter}');

    await expectFocusMovesTo(await screen.findByText(savedNotice));
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

    // 押した保存は送っている間押せなくなるので、断られたらフォーカスは断りへ移る。2回続けて断られても移る
    it('moves the focus to the reason, also on a second refusal', async () => {
      const user = userEvent.setup();
      failSave();
      render(<BackendUrlSettings />);

      saveButton().focus();
      await user.keyboard('{Enter}');
      await expectFocusMovesTo(await screen.findByRole('alert'));

      saveButton().focus();
      await user.keyboard('{Enter}');
      await expectFocusMovesTo(await screen.findByRole('alert'));
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

  // 保存すると出どころは config になるが、次の起動でまた引数が勝つ。注意は出どころでなく startupArgs で出す
  describe('the start-up argument warnings', () => {
    const urlWarning = /注意: 起動時に --backend-url/;
    const kindWarning = /注意: 起動時に --backend で/;

    it('keeps both warnings when the arguments are in effect, even though the sources are config after a save', () => {
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://gpu:7860', 'config', 'a1111', 'config', { kind: true, url: true }),
        error: undefined,
      } as never);
      render(<BackendUrlSettings />);

      expect(screen.getByText(urlWarning)).toBeTruthy();
      expect(screen.getByText(kindWarning)).toBeTruthy();
    });

    it('shows only the warning of the argument that is in effect', () => {
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://gpu:7860', 'config', 'a1111', 'config', { kind: false, url: true }),
        error: undefined,
      } as never);
      render(<BackendUrlSettings />);

      expect(screen.getByText(urlWarning)).toBeTruthy();
      expect(screen.queryByText(kindWarning)).toBeNull();
    });

    it('shows no warning when the arguments are not in effect, even though the sources say cli', () => {
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://gpu:7860', 'cli', 'a1111', 'cli', { kind: false, url: false }),
        error: undefined,
      } as never);
      render(<BackendUrlSettings />);

      expect(screen.queryByText(urlWarning)).toBeNull();
      expect(screen.queryByText(kindWarning)).toBeNull();
    });
  });

  describe('what a save sends', () => {
    const kindField = () => screen.getByLabelText<HTMLSelectElement>('バックエンドの種類');

    it('sends only the kind when only the kind was touched, so that the URL is not written to config.json', async () => {
      const user = userEvent.setup();
      render(<BackendUrlSettings />);

      await user.selectOptions(kindField(), 'a1111');
      await user.click(saveButton());

      expect(saveBackendSettings).toHaveBeenCalledTimes(1);
      expect(vi.mocked(saveBackendSettings).mock.calls[0]?.[0]).toEqual({ kind: 'a1111' });
    });

    it('sends only the URL when only the URL was touched', async () => {
      const user = userEvent.setup();
      render(<BackendUrlSettings />);

      await user.clear(field());
      await user.type(field(), 'http://127.0.0.1:7861');
      await user.click(saveButton());

      expect(vi.mocked(saveBackendSettings).mock.calls[0]?.[0]).toEqual({
        url: 'http://127.0.0.1:7861',
      });
    });

    it('sends both when both were touched', async () => {
      const user = userEvent.setup();
      render(<BackendUrlSettings />);

      await user.selectOptions(kindField(), 'a1111');
      await user.clear(field());
      await user.type(field(), 'http://127.0.0.1:7861');
      await user.click(saveButton());

      expect(vi.mocked(saveBackendSettings).mock.calls[0]?.[0]).toEqual({
        url: 'http://127.0.0.1:7861',
        kind: 'a1111',
      });
    });
  });

  describe('the kind', () => {
    const kindField = () => screen.getByLabelText<HTMLSelectElement>('バックエンドの種類');
    const warning =
      /ここで保存した種類はいまの起動中だけ効き、次に起動したときも同じ --backend を付ければ、そちらが勝つ/;

    it('offers Forge and A1111, with the kind in use selected', () => {
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://127.0.0.1:7860', 'config', 'a1111'),
        error: undefined,
      } as never);
      render(<BackendUrlSettings />);

      expect(kindField().value).toBe('a1111');
      expect(Array.from(kindField().options).map((option) => option.textContent)).toEqual([
        'Forge',
        'A1111',
      ]);
      expect(screen.queryByText(/起動時の --backend か config.json の/)).toBeNull();
    });

    it('saves the chosen kind, and says which kind and URL it connects to', async () => {
      const user = userEvent.setup();
      vi.mocked(saveBackendSettings).mockResolvedValue(
        view('http://127.0.0.1:7860', 'config', 'a1111'),
      );
      render(<BackendUrlSettings />);

      await user.selectOptions(kindField(), 'a1111');
      await user.click(saveButton());

      expect(vi.mocked(saveBackendSettings).mock.calls[0]?.[0]).toEqual({ kind: 'a1111' });
      expect(
        await screen.findByText('保存した。A1111 の http://127.0.0.1:7860 に繋ぐ。'),
      ).toBeTruthy();
    });

    // 触っていない種類を送ると、--backend で起動した種類が config.json に残り、次の起動の種類が変わる
    it('sends only the URL when the kind field was left alone, and still says which kind it is on', async () => {
      const user = userEvent.setup();
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://127.0.0.1:7860', 'config', 'a1111', 'cli'),
        error: undefined,
      } as never);
      vi.mocked(saveBackendSettings).mockResolvedValue(
        view('http://127.0.0.1:7860', 'config', 'a1111', 'cli'),
      );
      render(<BackendUrlSettings />);

      await user.click(saveButton());

      expect(saveBackendSettings).toHaveBeenCalledWith({ url: 'http://127.0.0.1:7860' });
      expect(
        await screen.findByText('保存した。A1111 の http://127.0.0.1:7860 に繋ぐ。'),
      ).toBeTruthy();
    });

    it('sends only the URL on a second save, once the chosen kind has been saved', async () => {
      const user = userEvent.setup();
      render(<BackendUrlSettings />);
      await user.selectOptions(kindField(), 'a1111');
      await user.click(saveButton());
      await screen.findByText(savedNotice);

      await user.click(saveButton());

      expect(saveBackendSettings).toHaveBeenCalledTimes(2);
      expect(saveBackendSettings).toHaveBeenNthCalledWith(1, { kind: 'a1111' });
      expect(saveBackendSettings).toHaveBeenNthCalledWith(2, { url: 'http://127.0.0.1:7860' });
    });

    it('says where the kind came from, apart from where the URL came from', () => {
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://127.0.0.1:7860', 'config', 'a1111', 'cli'),
        error: undefined,
      } as never);
      render(<BackendUrlSettings />);

      expect(screen.getByText('種類: A1111（起動の引数）')).toBeTruthy();
      expect(screen.getByText(/^いまの URL:/).textContent).toContain('（config.json）');
    });

    // 起動の引数と同じ URL を保存できる試験と同じく、同じ種類を送れないと config.json へ書く手段が無くなる
    it('sends the kind in use when it is chosen again, after another kind was picked in between', async () => {
      const user = userEvent.setup();
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://127.0.0.1:7860', 'config', 'a1111', 'cli'),
        error: undefined,
      } as never);
      render(<BackendUrlSettings />);

      await user.selectOptions(kindField(), 'forge');
      await user.selectOptions(kindField(), 'a1111');
      await user.click(saveButton());

      expect(vi.mocked(saveBackendSettings).mock.calls[0]?.[0]).toEqual({ kind: 'a1111' });
    });

    it('keeps the chosen kind when the settings are read again', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<BackendUrlSettings />);
      await user.selectOptions(kindField(), 'a1111');

      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://127.0.0.1:7860', 'default'),
        error: undefined,
      } as never);
      rerender(<BackendUrlSettings />);

      expect(kindField().value).toBe('a1111');
    });

    it('warns that the start-up --backend wins next time when the kind comes from it', () => {
      vi.mocked(useBackendSettings).mockReturnValue({
        data: view('http://127.0.0.1:7860', 'default', 'a1111', 'cli'),
        error: undefined,
      } as never);
      render(<BackendUrlSettings />);

      expect(screen.getByText(warning)).toBeTruthy();
    });

    it('does not show the kind warning when the kind comes from config or the default', () => {
      for (const kindSource of ['config', 'default'] as const) {
        vi.mocked(useBackendSettings).mockReturnValue({
          data: view('http://127.0.0.1:7860', 'cli', 'forge', kindSource),
          error: undefined,
        } as never);
        const { unmount } = render(<BackendUrlSettings />);

        expect(screen.queryByText(warning)).toBeNull();
        unmount();
      }
    });
  });
});
