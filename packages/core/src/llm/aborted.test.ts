import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateRecordingAbort, LLM_CALL_ABORTED_REASON } from './aborted.js';
import { LlmCallAborted, sealMessages, type LlmCall } from './port.js';

const messages = sealMessages('system', [], {
  estimatedInputTokens: 0,
  inputTokenLimit: 0,
  notes: [],
});

function callWith(signal: AbortSignal): LlmCall<unknown> {
  return { role: 'think', purpose: 'think', schema: z.unknown(), messages, signal };
}

describe('recording a call that the caller cut off', () => {
  it('does not record a call that failed on its own as cut off by the caller', async () => {
    const failure = new Error('connection lost');
    const onAborted = vi.fn(() => Promise.resolve());

    await expect(
      generateRecordingAbort(
        { generateStructured: () => Promise.reject(failure) },
        callWith(new AbortController().signal),
        onAborted,
      ),
    ).rejects.toBe(failure);

    expect(onAborted).not.toHaveBeenCalled();
  });

  it('records a call whose signal was aborted, with the attempts it had made', async () => {
    const controller = new AbortController();
    const attempts = [
      { rawOutput: '{"a', usage: { inputTokens: null, outputTokens: null }, durationMs: 5 },
    ];
    const onAborted = vi.fn(() => Promise.resolve());

    await expect(
      generateRecordingAbort(
        {
          generateStructured: () => {
            controller.abort();
            return Promise.reject(new LlmCallAborted(attempts, undefined));
          },
        },
        callWith(controller.signal),
        onAborted,
      ),
    ).rejects.toBeInstanceOf(LlmCallAborted);

    expect(onAborted).toHaveBeenCalledWith({
      ok: false,
      reason: LLM_CALL_ABORTED_REASON,
      attempts,
    });
  });
});
