import { stopConditionsChangeSchema } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import {
  buildStopConditions,
  buildStopConditionsChange,
  neverStops,
  stopConditionsBlocker,
  stopConditionsToForm,
  type StopConditionsFormValues,
} from './stop-conditions-form';

const empty: StopConditionsFormValues = {
  aiJudgement: false,
  maxIterations: '',
  maxImages: '',
  maxDurationMinutes: '',
};

describe('stopConditionsToForm', () => {
  it('turns milliseconds into minutes and leaves absent limits empty', () => {
    expect(
      stopConditionsToForm({ aiJudgement: true, maxIterations: 8, maxDurationMs: 90_000 }),
    ).toEqual({
      aiJudgement: true,
      maxIterations: '8',
      maxImages: '',
      maxDurationMinutes: '1.5',
    });
  });
});

describe('buildStopConditions', () => {
  it('omits empty limits and converts minutes to milliseconds', () => {
    expect(
      buildStopConditions({
        ...empty,
        aiJudgement: true,
        maxImages: '12',
        maxDurationMinutes: '2',
      }),
    ).toEqual({ ok: true, value: { aiJudgement: true, maxImages: 12, maxDurationMs: 120_000 } });
  });

  it('round-trips conditions through the form', () => {
    const conditions = { aiJudgement: false, maxIterations: 3, maxDurationMs: 30_000 };
    expect(buildStopConditions(stopConditionsToForm(conditions))).toEqual({
      ok: true,
      value: conditions,
    });
  });

  it.each([
    ['maxIterations', 'abc'],
    ['maxIterations', '1.5'],
    ['maxIterations', '0'],
    ['maxImages', '-2'],
    ['maxDurationMinutes', 'x'],
    ['maxDurationMinutes', '0'],
  ] as const)('rejects %s = %s with a reason instead of dropping it', (field, text) => {
    const built = buildStopConditions({ ...empty, aiJudgement: true, [field]: text });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain(text);
  });
});

describe('neverStops', () => {
  it('is true when there is no AI judgement and no limit', () => {
    expect(neverStops(empty)).toBe(true);
  });

  it.each([
    ['AI judgement', { aiJudgement: true }],
    ['iteration limit', { maxIterations: '5' }],
    ['image limit', { maxImages: '5' }],
    ['duration limit', { maxDurationMinutes: '5' }],
  ])('is false with only the %s', (_, patch) => {
    expect(neverStops({ ...empty, ...patch })).toBe(false);
  });

  it('is false for an unreadable value, which is reported separately', () => {
    expect(neverStops({ ...empty, maxIterations: 'abc' })).toBe(false);
  });
});

describe('buildStopConditionsChange', () => {
  it('sends every field and clears empty limits with null', () => {
    const built = buildStopConditionsChange({
      ...empty,
      aiJudgement: true,
      maxIterations: '5',
    });
    expect(built).toEqual({
      ok: true,
      value: { aiJudgement: true, maxIterations: 5, maxImages: null, maxDurationMs: null },
    });
    if (built.ok) expect(stopConditionsChangeSchema.safeParse(built.value).success).toBe(true);
  });

  it('rejects an unreadable limit', () => {
    expect(buildStopConditionsChange({ ...empty, maxImages: 'many' }).ok).toBe(false);
  });
});

describe('stopConditionsBlocker', () => {
  it('gives the reason when the conditions never stop', () => {
    expect(stopConditionsBlocker(empty)).toContain('止まらない');
  });

  it('gives the reason when a field is unreadable', () => {
    expect(stopConditionsBlocker({ ...empty, aiJudgement: true, maxImages: 'x' })).toContain('x');
  });

  it('gives nothing when the conditions stop', () => {
    expect(stopConditionsBlocker({ ...empty, maxIterations: '3' })).toBeUndefined();
  });
});
