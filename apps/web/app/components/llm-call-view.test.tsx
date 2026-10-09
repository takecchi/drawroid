// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnattachedLlmCalls } from './llm-call-view';

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
  ok: true,
  attempts: 1,
};

describe('UnattachedLlmCalls', () => {
  it('lists the calls that belong to no job with their tokens, and reads one only when opened', async () => {
    mocks.useUnattachedLlmCalls.mockReturnValue({
      data: {
        calls: [call],
        total: { calls: 1, inputTokens: 30, outputTokens: 4, durationMs: 1200 },
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
        total: { calls: 1, inputTokens: 30, outputTokens: 4, durationMs: 1200 },
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
        total: { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
        invalid: [],
      },
      error: undefined,
    });
    render(<UnattachedLlmCalls />);
    expect(screen.getByText('まだ無い。')).toBeTruthy();
  });
});
