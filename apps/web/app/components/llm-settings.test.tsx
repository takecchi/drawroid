// @vitest-environment jsdom
import { ApiError, type LlmSettingsResponse } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
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
