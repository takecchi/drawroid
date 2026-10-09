import { describe, expect, it } from 'vitest';
import { checkStopAtBoundary, effectiveStopConditions, type StopCheck } from './stop.js';

const base: StopCheck = {
  conditions: { aiJudgement: true },
  completedIterations: 0,
  imagesGenerated: 0,
  elapsedMs: 0,
  judgeSaysStop: false,
};

describe('checkStopAtBoundary', () => {
  it('keeps going when no condition is met', () => {
    expect(checkStopAtBoundary(base)).toBeUndefined();
  });

  it('stops when the judge says the intent is met', () => {
    expect(checkStopAtBoundary({ ...base, judgeSaysStop: true })?.kind).toBe('ai');
  });

  it('ignores the judge when stopping by AI judgement is off', () => {
    const check = { ...base, conditions: { aiJudgement: false }, judgeSaysStop: true };
    expect(checkStopAtBoundary(check)).toBeUndefined();
  });

  it('stops at the iteration, image and time limits', () => {
    expect(
      checkStopAtBoundary({
        ...base,
        conditions: { aiJudgement: false, maxIterations: 3 },
        completedIterations: 3,
      })?.kind,
    ).toBe('limit:iterations');
    expect(
      checkStopAtBoundary({
        ...base,
        conditions: { aiJudgement: false, maxImages: 4 },
        imagesGenerated: 4,
      })?.kind,
    ).toBe('limit:images');
    expect(
      checkStopAtBoundary({
        ...base,
        conditions: { aiJudgement: false, maxDurationMs: 60_000 },
        elapsedMs: 60_000,
      })?.kind,
    ).toBe('limit:duration');
  });

  it('prefers the AI judgement over a limit reached at the same time', () => {
    const check = {
      ...base,
      conditions: { aiJudgement: true, maxIterations: 2 },
      completedIterations: 2,
      judgeSaysStop: true,
    };
    expect(checkStopAtBoundary(check)?.kind).toBe('ai');
  });
});

describe('effectiveStopConditions', () => {
  const base = { aiJudgement: true, maxIterations: 5, maxImages: 20 };

  it('is the job conditions as they are while nothing has been changed', () => {
    expect(effectiveStopConditions(base, [])).toEqual(base);
  });

  it('changes only the fields a change names', () => {
    expect(effectiveStopConditions(base, [{ maxIterations: 8 }])).toEqual({
      aiJudgement: true,
      maxIterations: 8,
      maxImages: 20,
    });
  });

  it('lets a later change win over an earlier one', () => {
    expect(
      effectiveStopConditions(base, [
        { maxIterations: 8 },
        { maxIterations: 3, aiJudgement: false },
      ]),
    ).toEqual({ aiJudgement: false, maxIterations: 3, maxImages: 20 });
  });

  it('removes a limit when a change sets it to null, and adds one the job did not have', () => {
    expect(effectiveStopConditions(base, [{ maxImages: null, maxDurationMs: 60_000 }])).toEqual({
      aiJudgement: true,
      maxIterations: 5,
      maxDurationMs: 60_000,
    });
  });
});
