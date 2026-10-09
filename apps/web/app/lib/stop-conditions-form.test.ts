import { stopConditionsChangeSchema } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import {
  buildStopConditions,
  changedConditions,
  buildStopConditionsChange,
  describeStopConditions,
  neverStops,
  stopConditionsBlocker,
  stopConditionsToForm,
  type StopConditionsFormValues,
  describeStopConditions,
} from './stop-conditions-form';

const empty: StopConditionsFormValues = {
  aiJudgement: false,
  maxIterations: '',
  maxImages: '',
  maxDurationMinutes: '',
};

// 話す役が 1 分に満たない時間の上限を入れることがある（本物の小さなローカル LLM で、maxDurationMs: 5000）。
// 分で書くと「0.08333333333333333 分まで」になるので、1 分に満たない上限は秒で書く（core の describeStopConditions と同じ）。
// 1 秒に満たなければミリ秒で、秒に丸めて 60 になるなら分で書き、分の小数は2桁までにする
describe('describeStopConditions', () => {
  it.each([
    [400, '400 ミリ秒まで'],
    [5_000, '5 秒まで'],
    [59_000, '59 秒まで'],
    [59_500, '1 分まで'],
    [60_000, '1 分まで'],
    [90_000, '1.5 分まで'],
    [100_000, '1.67 分まで'],
    [600_000, '10 分まで'],
  ])('writes a time limit of %i ms as %s', (maxDurationMs, text) => {
    expect(describeStopConditions({ aiJudgement: false, maxDurationMs })).toEqual([text]);
  });
});

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

describe('changedConditions', () => {
  it('returns nothing when the conditions are the same', () => {
    expect(
      changedConditions(
        { aiJudgement: true, maxIterations: 10 },
        { aiJudgement: true, maxIterations: 10 },
      ),
    ).toEqual([]);
  });

  it('writes a time limit under a minute in seconds', () => {
    expect(
      changedConditions({ aiJudgement: true, maxDurationMs: 5_000 }, { aiJudgement: true }),
    ).toEqual([{ label: '時間の上限', submitted: '5 秒', current: 'なし' }]);
  });

  it('returns only the fields whose value differs, with absent limits as none', () => {
    expect(
      changedConditions(
        { aiJudgement: true, maxIterations: 10 },
        { aiJudgement: true, maxImages: 6, maxDurationMs: 90_000 },
      ),
    ).toEqual([
      { label: '回数の上限', submitted: '10 回', current: 'なし' },
      { label: '枚数の上限', submitted: 'なし', current: '6 枚' },
      { label: '時間の上限', submitted: 'なし', current: '1.5 分' },
    ]);
  });
});
