import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DRAWING_STOP_CONDITIONS,
  describeStopConditions,
  readDrawingStopConditions,
} from './drawing-tools.js';

// 本物の小さなローカル LLM が、頼まれていない止める条件（maxDurationMs: 5000）を入れたとき、知らせに「0 分まで」と出た。
// 人と話す役が読む文なので、1 分に満たない上限は秒で書く
describe('describeStopConditions', () => {
  it.each([
    [5_000, '5 秒まで'],
    [59_000, '59 秒まで'],
    [60_000, '1 分まで'],
    [600_000, '10 分まで'],
  ])('writes a time limit of %i ms as %s', (maxDurationMs, text) => {
    expect(describeStopConditions({ aiJudgement: false, maxDurationMs })).toBe(text);
  });

  it('never says 0 minutes for a limit under a minute', () => {
    expect(describeStopConditions({ aiJudgement: true, maxDurationMs: 1_000 })).not.toContain(
      '0 分',
    );
  });
});

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
