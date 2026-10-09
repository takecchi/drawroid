import { describe, expect, it } from 'vitest';

import { DEFAULT_DRAWING_STOP_CONDITIONS, readDrawingStopConditions } from './drawing-tools.js';

describe('readDrawingStopConditions', () => {
  it('uses the default when nothing is set', () => {
    expect(readDrawingStopConditions(undefined)).toEqual({
      conditions: DEFAULT_DRAWING_STOP_CONDITIONS,
    });
  });

  it('reads the default stop conditions written in the settings', () => {
    expect(
      readDrawingStopConditions({
        defaultStopConditions: { aiJudgement: false, maxIterations: 5 },
      }),
    ).toEqual({ conditions: { aiJudgement: false, maxIterations: 5 } });
  });

  it.each([
    ['of the wrong shape', { defaultStopConditions: { maxIterations: 'five' } }],
    ['that would never stop', { defaultStopConditions: { aiJudgement: false } }],
    ['that is not an object', 'often'],
  ])('falls back to the default, saying why, for settings %s', (_, raw) => {
    const read = readDrawingStopConditions(raw);

    expect(read.conditions).toEqual(DEFAULT_DRAWING_STOP_CONDITIONS);
    expect(read.problem).toBeDefined();
  });
});
