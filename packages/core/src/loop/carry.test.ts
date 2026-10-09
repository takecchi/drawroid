import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET } from './budget.js';
import { advanceCarry, createCarry } from './carry.js';
import type { JudgeOutput, ThinkParams } from './schemas.js';

const budget = DEFAULT_BUDGET;
const params: ThinkParams = { prompt: 'a girl' };

function judgement(scores: number[]): JudgeOutput {
  return {
    images: scores.map((score) => ({ score, issues: [] })),
    nextChange: '',
    canStop: false,
  };
}

describe('advanceCarry', () => {
  it('carries the highest-scoring image of the round when the later images score higher', () => {
    const start = createCarry('request', budget).carry;
    const carry = advanceCarry(start, 1, params, judgement([0.1, 0.5, 0.9]));
    expect(carry.latest?.imageIndex).toBe(2);
    expect(carry.latest?.score).toBe(0.9);
  });

  it('carries the highest-scoring image of the round when the middle one scores highest', () => {
    const start = createCarry('request', budget).carry;
    const carry = advanceCarry(start, 1, params, judgement([0.2, 0.9, 0.4]));
    expect(carry.latest?.imageIndex).toBe(1);
    expect(carry.latest?.score).toBe(0.9);
  });
});

describe('createCarry', () => {
  it('keeps a request within the intent limit', () => {
    const request = 'あ'.repeat(budget.text.intent);
    expect(createCarry(request, budget)).toEqual({
      carry: { intent: request, completedIterations: 0 },
    });
  });

  it('clips a request longer than the intent limit and reports the original length', () => {
    const request = 'あ'.repeat(budget.text.intent + 1);
    const { carry, intentClippedFrom } = createCarry(request, budget);
    expect([...carry.intent]).toHaveLength(budget.text.intent);
    expect(intentClippedFrom).toBe(budget.text.intent + 1);
  });
});
