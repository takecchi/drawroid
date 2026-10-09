import { describe, expect, it } from 'vitest';

import {
  budgetOverridesSchema,
  budgetsSchema,
  storedBudgetsSchema,
  DEFAULT_BUDGETS,
  resolveBudgets,
} from './settings.js';

describe('resolveBudgets', () => {
  it('returns the defaults when nothing is overridden', () => {
    expect(resolveBudgets({})).toEqual(DEFAULT_BUDGETS);
  });

  it('changes only the fields that were written', () => {
    const resolved = resolveBudgets({ imageLongEdge: 256, text: { prompt: 300 } });

    expect(resolved).toEqual({
      ...DEFAULT_BUDGETS,
      imageLongEdge: 256,
      text: { ...DEFAULT_BUDGETS.text, prompt: 300 },
    });
  });

  it('overlays deeply nested fields without dropping their siblings', () => {
    const resolved = resolveBudgets({ distill: { memory: { always: { maxCount: 2 } } } });

    expect(resolved.distill.memory.always).toEqual({
      ...DEFAULT_BUDGETS.distill.memory.always,
      maxCount: 2,
    });
    expect(resolved.distill.memory.maxCount).toBe(DEFAULT_BUDGETS.distill.memory.maxCount);
    expect(resolved.distill.output).toEqual(DEFAULT_BUDGETS.distill.output);
  });

  it('does not change the defaults', () => {
    const before = structuredClone(DEFAULT_BUDGETS);

    resolveBudgets({ distill: { memory: { always: { maxCount: 2 } } } });

    expect(DEFAULT_BUDGETS).toEqual(before);
  });
});

describe('budgetOverridesSchema', () => {
  it('accepts an empty object and nested partial objects', () => {
    expect(budgetOverridesSchema.safeParse({}).success).toBe(true);
    expect(
      budgetOverridesSchema.safeParse({ memory: { think: { maxCount: 2 } }, imagesPerJudge: 2 })
        .success,
    ).toBe(true);
  });

  it.each([
    ['an image long edge of 0', { imageLongEdge: 0 }],
    ['an image long edge of 10000', { imageLongEdge: 10_000 }],
    ['a fractional image long edge', { imageLongEdge: 256.5 }],
    ['0 images per judge', { imagesPerJudge: 0 }],
    ['9 images per judge', { imagesPerJudge: 9 }],
    ['a text limit of 0', { text: { prompt: 0 } }],
    ['a text limit far above the default', { text: { prompt: 600_000 } }],
    ['an unknown top-level key', { imageShortEdge: 256 }],
    ['an unknown nested key', { distill: { output: { bodyy: 80 } } }],
    ['a string where a number belongs', { issuesPerImage: '3' }],
  ])('rejects %s', (_name, value) => {
    expect(budgetOverridesSchema.safeParse(value).success).toBe(false);
  });
});

describe('budgetsSchema', () => {
  it('accepts the resolved defaults', () => {
    expect(budgetsSchema.safeParse(DEFAULT_BUDGETS).success).toBe(true);
  });

  it('rejects budgets with a field missing', () => {
    const withoutDistill: Record<string, unknown> = { ...DEFAULT_BUDGETS };
    delete withoutDistill.distill;

    expect(budgetsSchema.safeParse(withoutDistill).success).toBe(false);
  });
});

describe('storedBudgetsSchema', () => {
  it('still reads budgets written before a field was added or removed, and the missing field falls back to the default', () => {
    const older: Record<string, unknown> = { ...DEFAULT_BUDGETS, imageLongEdge: 256, retired: 1 };
    delete older.distill;

    const parsed = storedBudgetsSchema.safeParse(older);

    expect(parsed.success).toBe(true);
    const resolved = resolveBudgets(parsed.data ?? {});
    expect(resolved.imageLongEdge).toBe(256);
    expect(resolved.distill).toEqual(DEFAULT_BUDGETS.distill);
  });

  it('rejects a stored value out of range', () => {
    expect(storedBudgetsSchema.safeParse({ imageLongEdge: 0 }).success).toBe(false);
  });
});
