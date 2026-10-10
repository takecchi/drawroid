// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmTotals, UnattachedLlmCalls } from './llm-call-view';

const mocks = vi.hoisted(() => ({ useUnattachedLlmCalls: vi.fn(), useLlmCall: vi.fn() }));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  useUnattachedLlmCalls: mocks.useUnattachedLlmCalls,
  useLlmCall: mocks.useLlmCall,
}));

afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

const call = {
  callId: '20261009T000002Z-b',
  iteration: null,
  role: 'think' as const,
  purpose: 'stop-parse' as const,
  provider: 'local',
  model: 'qwen',
  startedAt: '2026-10-09T00:00:02.000Z',
  durationMs: 1200,
  usage: { inputTokens: 30, outputTokens: 4 },
  chars: { input: 120, output: 18 } as { input: number; output: number } | null,
  ok: true,
  attempts: 1,
};

const total = { calls: 1, inputTokens: 30, outputTokens: 4, durationMs: 1200 };

describe('chars of a call', () => {
  it('shows the input and output chars of each call next to its tokens', () => {
    mocks.useUnattachedLlmCalls.mockReturnValue({
      data: {
        calls: [call],
        total: { ...total, inputChars: 120, outputChars: 18 },
        invalid: [],
      },
      error: undefined,
    });
    render(<UnattachedLlmCalls />);

    expect(
      screen.getByText(
        /^止める条件を読む .* 出力 4 トークン \/ 入力 120 文字 \/ 出力 18 文字 \/ 1\.2 秒/,
      ),
    ).toBeTruthy();
  });

  it('says unknown for a call recorded before chars were kept, and for a total that includes one', () => {
    mocks.useUnattachedLlmCalls.mockReturnValue({
      data: {
        calls: [{ ...call, chars: null }],
        total: { ...total, inputChars: null, outputChars: null },
        invalid: [],
      },
      error: undefined,
    });
    render(<UnattachedLlmCalls />);

    expect(screen.getAllByText(/入力 不明 文字 \/ 出力 不明 文字/)).toHaveLength(2);
  });
});

describe('LlmTotals', () => {
  it('adds the chars to the summary line and to each iteration row', () => {
    render(
      <LlmTotals
        total={{ ...total, calls: 3, inputChars: 900, outputChars: 77 }}
        byIteration={[{ iteration: 1, ...total, inputChars: 900, outputChars: 77 }]}
      />,
    );

    expect(screen.getByText('入力 900 文字')).toBeTruthy();
    expect(screen.getByText('出力 77 文字')).toBeTruthy();
    expect(screen.getByText('900').getAttribute('data-label')).toBe('入力文字数');
    expect(screen.getByText('77').getAttribute('data-label')).toBe('出力文字数');
  });
});

describe('UnattachedLlmCalls', () => {
  it('lists the calls that belong to no job with their tokens, and reads one only when opened', async () => {
    mocks.useUnattachedLlmCalls.mockReturnValue({
      data: {
        calls: [call],
        total: { ...total, inputChars: 120, outputChars: 18 },
        invalid: [{ callId: '20261009T000001Z-x', reason: '形が違う' }],
      },
      error: undefined,
    });
    mocks.useLlmCall.mockReturnValue({
      data: {
        input: { system: 'SYSTEM', user: [{ type: 'text', text: '10回まで' }] },
        budget: { estimatedInputTokens: 30, inputTokenLimit: 7000, notes: [] },
        outcome: { ok: true, value: { maxIterations: 10 } },
      },
      error: undefined,
    });
    render(<UnattachedLlmCalls />);

    expect(
      screen.getByText(/止める条件を読む \/ qwen \/ 入力 30 トークン \/ 出力 4 トークン/),
    ).toBeTruthy();
    expect(screen.getByText('20261009T000001Z-x')).toBeTruthy();
    expect(mocks.useLlmCall).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByText('中身を見る'));
    // ジョブに属さない呼び出しとして読む（jobId は null）
    expect(mocks.useLlmCall).toHaveBeenCalledWith(null, '20261009T000002Z-b');
    expect(screen.getByText('10回まで')).toBeTruthy();
  });

  it.each([
    ['think', '考える役'],
    ['judge', '見る役'],
    ['ref-gist', '参照画像の要点'],
    ['distill', '覚える'],
    ['stop-parse', '止める条件を読む'],
    ['talk', '話す役'],
  ] as const)('calls a %s call by its Japanese name, %s', (purpose, name) => {
    mocks.useUnattachedLlmCalls.mockReturnValue({
      data: {
        calls: [{ ...call, purpose }],
        total: { ...total, inputChars: 120, outputChars: 18 },
        invalid: [],
      },
      error: undefined,
    });
    render(<UnattachedLlmCalls />);

    expect(screen.getByText(new RegExp(`^${name} / qwen / `))).toBeTruthy();
    expect(screen.queryByText(new RegExp(`^${purpose} / `))).toBeNull();
  });

  it('says there is none yet', () => {
    mocks.useUnattachedLlmCalls.mockReturnValue({
      data: {
        calls: [],
        total: {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          inputChars: 0,
          outputChars: 0,
        },
        invalid: [],
      },
      error: undefined,
    });
    render(<UnattachedLlmCalls />);
    expect(screen.getByText('まだ無い。')).toBeTruthy();
  });
});
