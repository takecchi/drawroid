import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, DEFAULT_MODEL_WINDOW } from '../loop/budget.js';
import { createCarry } from '../loop/carry.js';
import { buildJudgeInput } from '../loop/inputs.js';
import { toLlmCallRecord } from './record.js';

const messages = buildJudgeInput({
  carry: createCarry('海辺の少女', DEFAULT_BUDGET).carry,
  images: [
    {
      key: 'jobs/j1/iterations/0001/images/0',
      data: new Uint8Array(4096),
      mediaType: 'image/webp',
      longEdge: 512,
    },
  ],
  budget: DEFAULT_BUDGET,
  window: DEFAULT_MODEL_WINDOW,
});

const base = {
  callId: 'c1',
  jobId: 'j1',
  role: 'judge' as const,
  purpose: 'judge' as const,
  provider: 'openai-compatible',
  model: 'qwen',
  startedAt: new Date('2026-10-09T00:00:00Z'),
  messages,
};

describe('toLlmCallRecord', () => {
  it('records which iteration the call belongs to, or null for job-level calls', () => {
    const outcome = { ok: false as const, reason: 'x', attempts: [] };
    expect(toLlmCallRecord({ ...base, iteration: 3, outcome }).iteration).toBe(3);
    expect(toLlmCallRecord({ ...base, iteration: null, outcome }).iteration).toBeNull();
  });

  it('keeps images as keys, not their bytes', () => {
    const record = toLlmCallRecord({
      ...base,
      iteration: 1,
      outcome: { ok: false, reason: 'x', attempts: [] },
    });
    expect(record.input.user).toContainEqual({
      type: 'image',
      key: 'jobs/j1/iterations/0001/images/0',
    });
    expect(JSON.stringify(record)).not.toContain('"data"');
  });

  it('sums tokens and time over retries, and reports unknown when any attempt lacks usage', () => {
    const attempt = (inputTokens: number | null, durationMs: number) => ({
      rawOutput: '{}',
      usage: { inputTokens, outputTokens: 10 },
      durationMs,
    });
    const known = toLlmCallRecord({
      ...base,
      iteration: 1,
      outcome: { ok: true, value: {}, attempts: [attempt(100, 5), attempt(120, 7)] },
    });
    expect(known.usage).toEqual({ inputTokens: 220, outputTokens: 20 });
    expect(known.durationMs).toBe(12);

    const unknown = toLlmCallRecord({
      ...base,
      iteration: 1,
      outcome: { ok: true, value: {}, attempts: [attempt(100, 5), attempt(null, 7)] },
    });
    expect(unknown.usage.inputTokens).toBeNull();
  });
});
