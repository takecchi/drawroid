import { DEFAULT_BUDGETS } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { budgetLeaves } from './budget-form';
import { budgetLabel, groupBudgetLeaves } from './budget-labels';

describe('the labels of the budget fields', () => {
  it('describes every field of the default budget in Japanese', () => {
    // 予算に欄を足したら、ここが赤になる: 説明の無い内部名だけの欄を、初めての人に見せないため
    const missing = budgetLeaves(DEFAULT_BUDGETS)
      .map(({ path }) => path)
      .filter((path) => budgetLabel(path) === undefined);
    expect(missing).toEqual([]);
  });

  it('puts every field into one group, keeping the order, and loses none', () => {
    const leaves = budgetLeaves(DEFAULT_BUDGETS);
    const groups = groupBudgetLeaves(leaves);

    expect(groups.flatMap((group) => group.leaves.map((leaf) => leaf.path)).sort()).toEqual(
      leaves.map((leaf) => leaf.path).sort(),
    );
    expect(groups.map((group) => group.title)).not.toContain('そのほか');
  });

  it('keeps a field it does not know in a group of its own', () => {
    const groups = groupBudgetLeaves([{ path: 'text.intent' }, { path: 'future.newField' }]);

    expect(groups.at(-1)).toEqual({ title: 'そのほか', leaves: [{ path: 'future.newField' }] });
    expect(budgetLabel('future.newField')).toBeUndefined();
  });
});
