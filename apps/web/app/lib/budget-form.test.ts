import { describe, expect, it } from 'vitest';

import { budgetLeaves, buildBudgetOverrides, toBudgetFormValues } from './budget-form';

describe('budgetLeaves', () => {
  it('lists every number of the defaults with the path of its keys', () => {
    expect(
      budgetLeaves({
        imageLongEdge: 512,
        text: { prompt: 600 },
        memory: { think: { maxCount: 8 } },
      }),
    ).toEqual([
      { path: 'imageLongEdge', defaultValue: 512 },
      { path: 'text.prompt', defaultValue: 600 },
      { path: 'memory.think.maxCount', defaultValue: 8 },
    ]);
  });
});

describe('toBudgetFormValues', () => {
  it('shows each written number as text under the path of its keys', () => {
    expect(
      toBudgetFormValues({ imageLongEdge: 256, distill: { memory: { always: { maxCount: 2 } } } }),
    ).toEqual({ imageLongEdge: '256', 'distill.memory.always.maxCount': '2' });
  });

  it('shows nothing for settings that are not an object', () => {
    expect(toBudgetFormValues(undefined)).toEqual({});
    expect(toBudgetFormValues('x')).toEqual({});
  });
});

describe('buildBudgetOverrides', () => {
  it('leaves blank fields out so that they stay at the default', () => {
    expect(buildBudgetOverrides({ imageLongEdge: '', 'text.prompt': '  ' })).toEqual({
      ok: true,
      overrides: {},
    });
  });

  it('builds a nested tree from the paths and reads numbers from the text', () => {
    expect(
      buildBudgetOverrides({
        imageLongEdge: '256',
        'text.prompt': ' 300 ',
        'distill.memory.always.maxCount': '2',
        'distill.memory.maxCount': '',
      }),
    ).toEqual({
      ok: true,
      overrides: {
        imageLongEdge: 256,
        text: { prompt: 300 },
        distill: { memory: { always: { maxCount: 2 } } },
      },
    });
  });

  it.each([
    ['a fraction', '2.5', '整数で入れる'],
    ['letters', 'abc', '整数で入れる'],
    ['zero', '0', '1 以上で入れる'],
    ['a negative number', '-3', '1 以上で入れる'],
  ])('rejects %s with the reason', (_name, text, reason) => {
    expect(buildBudgetOverrides({ imageLongEdge: text })).toEqual({
      ok: false,
      errors: [{ path: 'imageLongEdge', reason }],
    });
  });

  it('reports every invalid field, not only the first', () => {
    const result = buildBudgetOverrides({
      imageLongEdge: 'x',
      'text.prompt': '0',
      issuesPerImage: '2',
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: 'imageLongEdge', reason: '整数で入れる' },
        { path: 'text.prompt', reason: '1 以上で入れる' },
      ],
    });
  });

  it('does not write through a __proto__ key', () => {
    buildBudgetOverrides(JSON.parse('{"__proto__.polluted": "3"}') as Record<string, string>);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
