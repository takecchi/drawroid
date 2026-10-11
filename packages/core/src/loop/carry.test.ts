import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET } from './budget.js';
import { adoptAsBest, advanceCarry, createCarry } from './carry.js';
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

  it('makes the image a human chose the best, even when it only ties the best so far', () => {
    const start = createCarry('request', budget).carry;
    const judged = advanceCarry(start, 1, params, judgement([1]));

    const carry = advanceCarry(judged, 2, params, { ...judgement([1]), adopted: true });

    expect(carry.best).toMatchObject({ iteration: 2, imageIndex: 0 });
  });

  it('keeps the earlier best when a later image only ties it', () => {
    const start = createCarry('request', budget).carry;
    const judged = advanceCarry(start, 1, params, judgement([0.8]));

    const carry = advanceCarry(judged, 2, params, judgement([0.8]));

    expect(carry.best).toMatchObject({ iteration: 1, imageIndex: 0, score: 0.8 });
    expect(carry.latest).toMatchObject({ iteration: 2, imageIndex: 0, score: 0.8 });
  });
});

describe('adoptAsBest', () => {
  const references = [{ refId: 'r1', gist: '夕暮れの海辺の構図' }];
  const judged = {
    ...advanceCarry(createCarry('request', budget).carry, 1, params, judgement([0.4])),
    references,
  };

  it('makes the chosen image the best with full score, leaving the latest result as it was', () => {
    const carry = adoptAsBest(judged, { iteration: 1, imageIndex: 0, params, issues: [] });

    expect(carry.best).toMatchObject({ iteration: 1, imageIndex: 0, score: 1 });
    expect(carry.latest).toEqual(judged.latest);
  });

  it('keeps the gists of the reference images', () => {
    const carry = adoptAsBest(judged, { iteration: 1, imageIndex: 0, params, issues: [] });

    expect(carry.references).toEqual(references);
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
