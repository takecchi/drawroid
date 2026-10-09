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
        imageInput: false,
      },
      judge: {
        provider: 'cloud',
        model: 'claude-haiku-5-5',
        contextTokens: 32000,
        maxOutputTokens: 1024,
        structuredOutput: 'native',
        imageInput: true,
      },
    },
    validationRetries: 2,
    networkRetries: 2,
  },
  apiKeyEnv: { cloud: { name: 'ANTHROPIC_API_KEY', set: false } },
  outputLimitWarnings: [],
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

  it('leaves the judging role out when it uses the same model as the thinking role', async () => {
    const user = userEvent.setup();
    render(<LlmSettings />);

    await user.click(screen.getByLabelText('見る役も考える役と同じモデルを使う'));
    await user.click(screen.getByRole('button', { name: 'LLM の設定を保存' }));

    const [saved] = mocks.saveLlmSettings.mock.calls[0] as [{ roles: object }];
    expect(saved.roles).toEqual({ think: stored.config!.roles.think });
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

  it('warns about a stored output limit that is likely too small, without changing the value', () => {
    const message =
      '考える役の出力の上限（llm.roles.think.maxOutputTokens = 1024）は、出力の見積もり（約 1139 トークン）より小さく、出力が切れて止まる見込みがある。考える役の「出力の上限（トークン）」を 2048 以上に上げる（値は自動では書き換えない）。';
    mocks.useLlmSettings.mockReturnValue({
      data: {
        ...stored,
        outputLimitWarnings: [
          {
            role: 'think',
            configKey: 'think',
            maxOutputTokens: 1024,
            estimatedOutputTokens: 1139,
            message,
          },
        ],
      },
      error: undefined,
    });
    render(<LlmSettings />);

    expect(screen.getByRole('status').textContent).toBe(`警告: ${message}`);
    expect(input('考える役の出力の上限').value).toBe('1024');
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
