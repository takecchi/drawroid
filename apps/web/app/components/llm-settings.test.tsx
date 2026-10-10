// @vitest-environment jsdom
import { ApiError, type LlmSettingsInput, type LlmSettingsResponse } from '@drawroid/swr';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmSettings } from './llm-settings';

const mocks = vi.hoisted(() => ({
  saveLlmSettings: vi.fn(),
  useLlmSettings: vi.fn(),
}));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  saveLlmSettings: mocks.saveLlmSettings,
  useLlmSettings: mocks.useLlmSettings,
}));

afterEach(cleanup);

const stored: LlmSettingsResponse = {
  config: {
    providers: {
      local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' },
      cloud: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
    roles: {
      think: {
        provider: 'local',
        model: 'qwen2.5',
        contextTokens: 8192,
        maxOutputTokens: 1024,
        structuredOutput: 'native',
        reasoning: 'think-tag',
        toolCalling: 'native',
        imageInput: false,
      },
      judge: {
        provider: 'cloud',
        model: 'claude-haiku-5-5',
        contextTokens: 32000,
        maxOutputTokens: 1024,
        structuredOutput: 'native',
        reasoning: 'native',
        toolCalling: 'native',
        imageInput: true,
      },
    },
    validationRetries: 2,
    networkRetries: 2,
  },
  apiKeyEnv: { cloud: { name: 'ANTHROPIC_API_KEY', set: false } },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useLlmSettings.mockReturnValue({ data: stored, error: undefined });
  mocks.saveLlmSettings.mockResolvedValue(stored);
});

const input = (label: string) => screen.getByLabelText<HTMLInputElement>(label);

describe('LlmSettings', () => {
  it('shows the provider, model and endpoint of each role as they are set', () => {
    render(<LlmSettings />);

    expect(input('考える役の provider').value).toBe('local');
    expect(input('考える役のモデル').value).toBe('qwen2.5');
    expect(input('見る役の provider').value).toBe('cloud');
    expect(input('見る役のモデル').value).toBe('claude-haiku-5-5');
    expect(input('provider local の接続先（baseURL）').value).toBe('http://127.0.0.1:11434/v1');
  });

  // 役ごとに同じ欄が並ぶので、どの役の欄かを読み上げの名前で区別できる
  it('names whether each role reads images after the role', () => {
    render(<LlmSettings />);

    expect(input('考える役は画像を読める').checked).toBe(false);
    expect(input('見る役は画像を読める').checked).toBe(true);
  });

  it('lets each role choose its provider only from the providers defined above', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    const think = screen.getByRole('combobox', { name: '考える役の provider' });
    expect(
      within(think)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['local', 'cloud']);
    // 打つ欄は置かない: 打ち違えた名前は保存して初めて断られるため
    expect(screen.queryByRole('textbox', { name: '考える役の provider' })).toBeNull();

    await user.selectOptions(think, 'cloud');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('cloud');
  });

  it('chooses the only provider for every role at the first setup, and saves it', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);

    await user.type(input('provider 1番目 の名前'), 'local');
    await user.type(input('provider local の接続先（baseURL）'), 'http://127.0.0.1:11434/v1');
    await user.type(input('考える役のモデル'), 'qwen2.5');
    await user.click(screen.getByLabelText('見る役も考える役と同じモデルを使う'));
    await user.type(input('見る役のモデル'), 'qwen2.5vl');
    await user.click(screen.getByLabelText('話す役（会話）も考える役と同じモデルを使う'));
    await user.type(input('話す役のモデル'), 'qwen2.5');

    expect(input('考える役の provider').value).toBe('local');
    expect(input('見る役の provider').value).toBe('local');
    expect(input('話す役の provider').value).toBe('local');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    const saved = mocks.saveLlmSettings.mock.calls[0]?.[0];
    expect(saved.roles.think.provider).toBe('local');
    expect(saved.roles.judge.provider).toBe('local');
    expect(saved.roles.talk.provider).toBe('local');
  });

  it('keeps the provider each role showed as chosen when a second provider is added', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.type(input('provider local の接続先（baseURL）'), 'http://127.0.0.1:11434/v1');
    await user.type(input('考える役のモデル'), 'qwen2.5');
    await user.click(screen.getByLabelText('見る役も考える役と同じモデルを使う'));
    await user.type(input('見る役のモデル'), 'qwen2.5vl');
    await user.click(screen.getByLabelText('話す役（会話）も考える役と同じモデルを使う'));
    await user.type(input('話す役のモデル'), 'qwen2.5');

    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の名前'), 'cloud');

    expect(input('考える役の provider').value).toBe('local');
    expect(input('見る役の provider').value).toBe('local');
    expect(input('話す役の provider').value).toBe('local');
    expect(
      within(screen.getByRole('combobox', { name: '考える役の provider' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['local', 'cloud']);
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    const saved = mocks.saveLlmSettings.mock.calls[0]?.[0];
    expect(saved.roles.think.provider).toBe('local');
    expect(saved.roles.judge.provider).toBe('local');
    expect(saved.roles.talk.provider).toBe('local');
    // 自動で持たせたかどうかは画面の中だけの印で、保存する形には載せない
    expect(saved.roles.think).not.toHaveProperty('providerPinned');
  });

  it('keeps the provider each role showed as chosen when a second name is typed into a row added before', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    const think = () => screen.getByRole('combobox', { name: '考える役の provider' });
    const optionsOf = (select: HTMLElement) =>
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent);
    expect(optionsOf(think())).toEqual(['先に provider を定義する']);

    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.type(input('考える役のモデル'), 'qwen2.5');
    // 名前の無い行は provider に数えない
    expect(optionsOf(think())).toEqual(['local']);
    expect(input('考える役の provider').value).toBe('local');

    await user.type(input('provider 2番目 の名前'), 'cloud');

    expect(input('考える役の provider').value).toBe('local');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('local');
  });

  // 役に名前を持たせるのは、2つ目の「名前」が付いたときだけ。空白だけの行や、同じ名前を貼った行は2つ目の名前ではない
  it('keeps following the only provider while a row of only spaces is left, as its name is typed further', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の名前'), '  ');

    await user.type(input('provider local の名前'), '2');

    expect(input('考える役の provider').value).toBe('local2');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('local2');
  });

  it.each([
    [
      'only spaces',
      (user: ReturnType<typeof userEvent.setup>) => user.type(input('provider 2番目 の名前'), '  '),
    ],
    [
      'the same name pasted',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(input('provider 2番目 の名前'));
        await user.paste('local');
      },
    ],
  ])(
    'keeps following the only provider when a row given %s is taken away and the name is typed again',
    async (_, fillSecondRow) => {
      const user = userEvent.setup();
      mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
      render(<LlmSettings />);
      await user.type(input('provider 1番目 の名前'), 'local');
      await user.type(input('考える役のモデル'), 'qwen2.5');

      await user.click(screen.getByRole('button', { name: 'provider を足す' }));
      await fillSecondRow(user);
      const remove = screen.getAllByRole('button', { name: /^provider .+ を外す$/ });
      await user.click(remove[1]!);
      await user.clear(input('provider local の名前'));
      await user.type(input('provider 1番目 の名前'), 'lm');

      expect(input('考える役の provider').value).toBe('lm');
      await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
      expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('lm');
    },
  );

  // 2つ目の名前が付いたときに役へ持たせた名前は、人が選んだものではない。1つに戻ったら外し、1つだけのときの既定に戻す
  it.each([
    [
      'taken away',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'provider cloud を外す' })),
    ],
    [
      'cleared of its name',
      (user: ReturnType<typeof userEvent.setup>) => user.clear(input('provider cloud の名前')),
    ],
  ])(
    'lets every role follow the only provider again when the second one is %s, and its name is typed again',
    async (_, backToOne) => {
      const user = userEvent.setup();
      mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
      render(<LlmSettings />);
      await user.type(input('provider 1番目 の名前'), 'local');
      await user.click(screen.getByLabelText('見る役も考える役と同じモデルを使う'));
      await user.click(screen.getByLabelText('話す役（会話）も考える役と同じモデルを使う'));

      await user.click(screen.getByRole('button', { name: 'provider を足す' }));
      await user.type(input('provider 2番目 の名前'), 'cloud');
      expect(input('考える役の provider').value).toBe('local');
      await backToOne(user);
      await user.clear(input('provider local の名前'));
      await user.type(input('provider 1番目 の名前'), 'lm');

      for (const role of ['考える役', '見る役', '話す役']) {
        expect(input(`${role}の provider`).value).toBe('lm');
      }
      await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
      const saved = mocks.saveLlmSettings.mock.calls[0]?.[0];
      expect([
        saved.roles.think.provider,
        saved.roles.judge.provider,
        saved.roles.talk.provider,
      ]).toEqual(['lm', 'lm', 'lm']);
    },
  );

  it('lets the roles follow the one left when the provider they were given is taken away', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の名前'), 'cloud');

    await user.click(screen.getByRole('button', { name: 'provider local を外す' }));

    expect(input('考える役の provider').value).toBe('cloud');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('cloud');
  });

  it('keeps the provider a role was saved with when a second one comes and goes', async () => {
    const user = userEvent.setup();
    const { local } = stored.config!.providers;
    mocks.useLlmSettings.mockReturnValue({
      data: {
        config: {
          ...stored.config!,
          providers: { local },
          roles: { think: stored.config!.roles.think },
        },
        apiKeyEnv: {},
      },
      error: undefined,
    });
    render(<LlmSettings />);

    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の名前'), 'cloud');
    await user.click(screen.getByRole('button', { name: 'provider cloud を外す' }));
    await user.clear(input('provider local の名前'));
    await user.type(input('provider 1番目 の名前'), 'lm');

    expect(input('考える役の provider').value).toBe('local');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('local');
  });

  // 人が選んだ名前は、たまたま自動で持たせる名前と同じでも外さない
  it('keeps the provider a person chose when the second one is taken away, while the roles left alone follow the only one', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.click(screen.getByLabelText('見る役も考える役と同じモデルを使う'));
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の名前'), 'cloud');

    const think = screen.getByRole('combobox', { name: '考える役の provider' });
    await user.selectOptions(think, 'cloud');
    await user.selectOptions(think, 'local');
    await user.click(screen.getByRole('button', { name: 'provider cloud を外す' }));
    await user.clear(input('provider local の名前'));
    await user.type(input('provider 1番目 の名前'), 'lm');

    expect(input('考える役の provider').value).toBe('local');
    expect(within(think).getByRole('option', { name: 'local（定義に無い）' })).toBeTruthy();
    expect(input('見る役の provider').value).toBe('lm');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    const saved = mocks.saveLlmSettings.mock.calls[0]?.[0];
    expect(saved.roles.think.provider).toBe('local');
    expect(saved.roles.judge.provider).toBe('lm');
  });

  // 見る役の欄を出す前に持たせた名前も、自動で持たせたもののまま。出したあとに考える役で選んでも、見る役は選んだことにならない
  it('lets a role shown after the second provider came follow the only one, while the role the person chose stays', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の名前'), 'cloud');
    const think = screen.getByRole('combobox', { name: '考える役の provider' });
    await user.selectOptions(think, 'cloud');
    await user.selectOptions(think, 'local');
    await user.click(screen.getByLabelText('見る役も考える役と同じモデルを使う'));
    expect(input('見る役の provider').value).toBe('local');

    await user.click(screen.getByRole('button', { name: 'provider cloud を外す' }));
    await user.clear(input('provider local の名前'));
    await user.type(input('provider 1番目 の名前'), 'lm');

    expect(input('考える役の provider').value).toBe('local');
    expect(input('見る役の provider').value).toBe('lm');
  });

  // 保存した値は、自動で持たせたものでも、保存したあとは人が決めた値として扱う（開き直したときと同じ）
  it('treats the provider it gave a role as chosen once the settings are saved', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    // saveLlmSettings は、保存の応答を読む口の値に置く。応答は、サーバが送られた設定を llmConfigSchema で読んだ形
    // （省いた欄はスキーマの既定で埋まる）
    mocks.saveLlmSettings.mockImplementation(async (config: LlmSettingsInput) => {
      const role = (sent: LlmSettingsInput['roles']['think']) => ({
        ...sent,
        structuredOutput: sent.structuredOutput ?? 'native',
        reasoning: sent.reasoning ?? 'native',
        toolCalling: sent.toolCalling ?? 'native',
        imageInput: sent.imageInput ?? true,
      });
      const response: LlmSettingsResponse = {
        config: {
          providers: config.providers,
          roles: {
            think: role(config.roles.think),
            ...(config.roles.judge === undefined ? {} : { judge: role(config.roles.judge) }),
            ...(config.roles.talk === undefined ? {} : { talk: role(config.roles.talk) }),
          },
          validationRetries: config.validationRetries ?? 2,
          networkRetries: config.networkRetries ?? 2,
        },
        apiKeyEnv: {},
      };
      mocks.useLlmSettings.mockReturnValue({ data: response, error: undefined });
      return response;
    });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.type(input('provider local の接続先（baseURL）'), 'http://127.0.0.1:11434/v1');
    await user.type(input('考える役のモデル'), 'qwen2.5');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の名前'), 'cloud');
    // サーバが受ける形にする: 接続先の無い openai-compatible は断られる
    await user.selectOptions(input('provider cloud の種類'), 'anthropic');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    await screen.findByText(/保存した/);
    expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('local');

    await user.click(screen.getByRole('button', { name: 'provider cloud を外す' }));
    await user.clear(input('provider local の名前'));
    await user.type(input('provider 1番目 の名前'), 'lm');

    const think = screen.getByRole('combobox', { name: '考える役の provider' });
    expect(input('考える役の provider').value).toBe('local');
    expect(within(think).getByRole('option', { name: 'local（定義に無い）' })).toBeTruthy();
  });

  it('does not choose for the person when two providers are defined and the role has none', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({
      data: {
        config: {
          ...stored.config!,
          roles: { think: { ...stored.config!.roles.think, provider: '' } },
        },
      },
      error: undefined,
    });
    render(<LlmSettings />);

    const think = () =>
      screen.getByRole<HTMLSelectElement>('combobox', { name: '考える役の provider' });
    expect(think().value).toBe('');
    expect(
      within(think())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['選ぶ', 'local', 'cloud']);

    // 足しても、どれかを選んだことにはしない（既定が効くのは1つだけのときに限る）
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    expect(think().value).toBe('');
    await user.type(input('provider 3番目 の名前'), 'other');
    expect(think().value).toBe('');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('');
  });

  it('keeps showing a role that points at a provider no longer defined, so saving can say why', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.clear(input('provider local の名前'));
    await user.type(input('provider 1番目 の名前'), 'lm');

    const think = screen.getByRole('combobox', { name: '考える役の provider' });
    expect((think as HTMLSelectElement).value).toBe('local');
    expect(within(think).getByRole('option', { name: 'local（定義に無い）' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    // 直さずに送る: 定義に無い名前はサーバの検証が理由付きで断る
    expect(mocks.saveLlmSettings.mock.calls[0]?.[0].roles.think.provider).toBe('local');
  });

  it('drops the spaces typed around a provider name, both where roles choose it and where it is saved', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);

    await user.type(input('provider 1番目 の名前'), ' local ');
    await user.type(input('provider local の接続先（baseURL）'), 'http://127.0.0.1:11434/v1');
    await user.type(input('考える役のモデル'), 'qwen2.5');

    const think = screen.getByRole<HTMLSelectElement>('combobox', { name: '考える役の provider' });
    expect(think.value).toBe('local');
    expect(
      within(think)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['local']);
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    const saved = mocks.saveLlmSettings.mock.calls[0]?.[0];
    expect(Object.keys(saved.providers)).toEqual(['local']);
    expect(saved.roles.think.provider).toBe('local');
  });

  it('reads a role that points at a provider name with spaces around it as that provider', async () => {
    const user = userEvent.setup();
    // config.json を手で書いたときにだけ起きる（画面から保存した名前は空白を落としてある）
    mocks.useLlmSettings.mockReturnValue({
      data: {
        config: {
          ...stored.config!,
          providers: { ' local ': stored.config!.providers.local! },
          roles: { think: { ...stored.config!.roles.think, provider: ' local ' } },
        },
      },
      error: undefined,
    });
    render(<LlmSettings />);

    const think = screen.getByRole<HTMLSelectElement>('combobox', { name: '考える役の provider' });
    expect(think.value).toBe('local');
    expect(
      within(think)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['local']);
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    const saved = mocks.saveLlmSettings.mock.calls[0]?.[0];
    expect(Object.keys(saved.providers)).toEqual(['local']);
    expect(saved.roles.think.provider).toBe('local');
  });

  it('refuses to save two providers of the same name, spaces around it aside, and keeps what was typed', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.clear(input('provider cloud の名前'));
    await user.type(input('provider 2番目 の名前'), ' local');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'provider の名前「local」が2つある',
    );
    expect(mocks.saveLlmSettings).not.toHaveBeenCalled();
    expect(
      screen
        .getAllByLabelText<HTMLInputElement>('provider local の名前')
        .map((field) => field.value),
    ).toEqual(['local', ' local']);
  });

  it('lists a name given to two rows once among the choices of a role, until saving says it is given twice', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.clear(input('provider cloud の名前'));
    await user.type(input('provider 2番目 の名前'), ' local');

    expect(
      within(screen.getByRole('combobox', { name: '考える役の provider' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['local']);
  });

  it('does not take rows without a name, or names that only look alike, as the same provider', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.clear(input('provider cloud の名前'));
    await user.type(input('provider 2番目 の名前'), 'local2');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(mocks.saveLlmSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('saves without a provider row that was added and left empty', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.type(input('provider local の接続先（baseURL）'), 'http://127.0.0.1:11434/v1');
    await user.type(input('考える役のモデル'), 'qwen2.5');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));

    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(Object.keys(mocks.saveLlmSettings.mock.calls[0]?.[0].providers)).toEqual(['local']);
  });

  it('refuses to save a provider row that has an endpoint but no name, saying which row', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.type(input('provider local の接続先（baseURL）'), 'http://127.0.0.1:11434/v1');
    await user.type(input('考える役のモデル'), 'qwen2.5');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の接続先（baseURL）'), 'http://127.0.0.1:1234/v1');

    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect((await screen.findByRole('alert')).textContent).toContain('provider 2番目 に名前が無い');
    expect(mocks.saveLlmSettings).not.toHaveBeenCalled();
    expect(input('provider 2番目 の接続先（baseURL）').value).toBe('http://127.0.0.1:1234/v1');
  });

  it.each([
    [
      'only the variable that holds a key',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.type(input('provider 2番目 の API キーの環境変数'), 'OPENROUTER_API_KEY'),
    ],
    [
      'an endpoint and a name of only spaces',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(input('provider 2番目 の接続先（baseURL）'), 'http://127.0.0.1:1234/v1');
        await user.type(input('provider 2番目 の名前'), '  ');
      },
    ],
  ])('refuses to save a provider row given %s, saying which row', async (_, fillSecondRow) => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.type(input('provider local の接続先（baseURL）'), 'http://127.0.0.1:11434/v1');
    await user.type(input('考える役のモデル'), 'qwen2.5');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await fillSecondRow(user);

    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect((await screen.findByRole('alert')).textContent).toContain('provider 2番目 に名前が無い');
    expect(mocks.saveLlmSettings).not.toHaveBeenCalled();
  });

  // 使っていない行かどうかは、名前・接続先・鍵の変数に何か入れたかで見る。空白だけや、種類だけを変えた行は入れていない
  it('saves without rows given only spaces or only another kind, as rows left empty', async () => {
    const user = userEvent.setup();
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);
    await user.type(input('provider 1番目 の名前'), 'local');
    await user.type(input('provider local の接続先（baseURL）'), 'http://127.0.0.1:11434/v1');
    await user.type(input('考える役のモデル'), 'qwen2.5');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.type(input('provider 2番目 の接続先（baseURL）'), '  ');
    await user.type(input('provider 2番目 の API キーの環境変数'), '  ');
    await user.click(screen.getByRole('button', { name: 'provider を足す' }));
    await user.selectOptions(input('provider 3番目 の種類'), 'anthropic');

    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(Object.keys(mocks.saveLlmSettings.mock.calls[0]?.[0].providers)).toEqual(['local']);
  });

  it('shows only the name of the variable that holds a key and whether it is set', () => {
    render(<LlmSettings />);

    expect(input('provider cloud の API キーの環境変数').value).toBe('ANTHROPIC_API_KEY');
    expect(screen.getByText(/ANTHROPIC_API_KEY は入っていない/)).toBeTruthy();
    // 値の欄そのものを置かない: 秘密は環境変数に置き、画面と設定には名前だけを出す
    expect(screen.queryByLabelText(/API キーの値/)).toBeNull();
  });

  it('saves the edited model, keeping the rest of the settings', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.clear(input('考える役のモデル'));
    await user.type(input('考える役のモデル'), 'qwen3');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(mocks.saveLlmSettings).toHaveBeenCalledWith({
      ...stored.config,
      roles: {
        think: { ...stored.config!.roles.think, model: 'qwen3' },
        judge: stored.config!.roles.judge,
      },
    });
  });

  it('says it saved, until the person edits the settings again', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    expect(
      await screen.findByText('保存した。次に話しかけたときから、この設定を使う。'),
    ).toBeTruthy();

    await user.type(input('考える役のモデル'), '-next');
    expect(screen.queryByText('保存した。次に話しかけたときから、この設定を使う。')).toBeNull();
  });

  it('does not say it saved when saving fails', async () => {
    mocks.saveLlmSettings.mockRejectedValue(new ApiError('invalid_request', '形が合わない', 400));
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(await screen.findByText('保存できない: 形が合わない')).toBeTruthy();
    expect(screen.queryByText('保存した。次に話しかけたときから、この設定を使う。')).toBeNull();
  });

  it('takes back that it saved when saving again fails', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));
    expect(
      await screen.findByText('保存した。次に話しかけたときから、この設定を使う。'),
    ).toBeTruthy();

    mocks.saveLlmSettings.mockRejectedValue(new ApiError('invalid_request', '形が合わない', 400));
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(await screen.findByText('保存できない: 形が合わない')).toBeTruthy();
    expect(screen.queryByText('保存した。次に話しかけたときから、この設定を使う。')).toBeNull();
  });

  it('saves how each role takes the thinking of the model', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    expect(screen.getByLabelText<HTMLSelectElement>('考える役の思考の受け取り方').value).toBe(
      'think-tag',
    );
    await user.selectOptions(screen.getByLabelText('見る役の思考の受け取り方'), 'none');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(mocks.saveLlmSettings).toHaveBeenCalledWith({
      ...stored.config,
      roles: {
        think: stored.config!.roles.think,
        judge: { ...stored.config!.roles.judge, reasoning: 'none' },
      },
    });
  });

  it('saves a separate model for the talking role when it does not use the thinking role', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.click(screen.getByLabelText('話す役（会話）も考える役と同じモデルを使う'));
    await user.clear(input('話す役のモデル'));
    await user.type(input('話す役のモデル'), 'qwen3-talk');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(mocks.saveLlmSettings).toHaveBeenCalledWith({
      ...stored.config,
      roles: {
        ...stored.config!.roles,
        talk: { ...stored.config!.roles.think, model: 'qwen3-talk' },
      },
    });
  });

  it('saves json tool calling for a model that is weak at calling tools', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.selectOptions(screen.getByLabelText('考える役のツールの呼び出し方'), 'json');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(mocks.saveLlmSettings).toHaveBeenCalledWith({
      ...stored.config,
      roles: {
        ...stored.config!.roles,
        think: { ...stored.config!.roles.think, toolCalling: 'json' },
      },
    });
  });

  it('leaves the judging role out when it uses the same model as the thinking role', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.click(screen.getByLabelText('見る役も考える役と同じモデルを使う'));
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    const [saved] = mocks.saveLlmSettings.mock.calls[0] as [{ roles: object }];
    expect(saved.roles).toEqual({ think: stored.config!.roles.think });
  });

  it('shows and saves how many times to retry', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    expect(input('出力が形に合わないときの再試行の回数').value).toBe('2');
    expect(input('繋がらない・混んでいるときの再試行の回数').value).toBe('2');
    await user.clear(input('出力が形に合わないときの再試行の回数'));
    await user.type(input('出力が形に合わないときの再試行の回数'), '4');
    await user.clear(input('繋がらない・混んでいるときの再試行の回数'));
    await user.type(input('繋がらない・混んでいるときの再試行の回数'), '0');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect(mocks.saveLlmSettings).toHaveBeenCalledWith({
      ...stored.config,
      validationRetries: 4,
      networkRetries: 0,
    });
  });

  it('leaves an emptied retry count to the server default', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.clear(input('繋がらない・混んでいるときの再試行の回数'));
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    const [saved] = mocks.saveLlmSettings.mock.calls[0] as [object];
    expect(saved).not.toHaveProperty('networkRetries');
    expect(saved).toHaveProperty('validationRetries', 2);
  });

  it('shows why when the settings cannot be built, and keeps what was typed', async () => {
    const user = userEvent.setup();
    mocks.saveLlmSettings.mockRejectedValue(
      new ApiError('invalid_request', 'provider「cloud」の API キーの環境変数が入っていない', 400),
    );
    render(<LlmSettings />);

    await user.clear(input('見る役のモデル'));
    await user.type(input('見る役のモデル'), 'claude-sonnet-5-5');
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'provider「cloud」の API キーの環境変数が入っていない',
    );
    expect(input('見る役のモデル').value).toBe('claude-sonnet-5-5');
  });

  it('starts an empty form for the first setup when nothing is set', () => {
    mocks.useLlmSettings.mockReturnValue({ data: { config: null }, error: undefined });
    render(<LlmSettings />);

    expect(screen.getByText(/まだ LLM が設定されていない/)).toBeTruthy();
    expect(input('考える役のモデル').value).toBe('');
  });

  it('says the stored settings cannot be read', () => {
    mocks.useLlmSettings.mockReturnValue({
      data: undefined,
      error: new ApiError('invalid_config', 'roles.think.model: 空', 500),
    });
    render(<LlmSettings />);

    expect(screen.getByRole('alert').textContent).toContain('roles.think.model: 空');
  });
});
