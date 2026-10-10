import { DEFAULT_BUDGETS } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { budgetLeaves } from './budget-form';
import { budgetFieldName, budgetLabel, groupBudgetLeaves, nameBudgetFields } from './budget-labels';

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

  it('names a field by its label and its internal name, or by the internal name alone when unknown', () => {
    expect(budgetFieldName('candidates.maxSize')).toBe(
      '考える役に見せる候補の量（candidates.maxSize）',
    );
    expect(budgetFieldName('future.newField')).toBe('future.newField');
  });

  it('replaces only the known internal names in a sentence, leaving other letters as they are', () => {
    expect(
      nameBudgetFields(
        '欄は candidates.maxSize。HTTP の candidates.noSuchField と imageLongEdge は text.intent.',
      ),
    ).toBe(
      '欄は 考える役に見せる候補の量（candidates.maxSize）。HTTP の candidates.noSuchField と ' +
        'LLM に見せる縮小画像の長辺（px）（imageLongEdge） は 依頼の要点の文字数（text.intent）.',
    );
  });

  // 添えられる枚数と読み違えないように: この欄は、ジョブに添えた参照画像のうち、新しいものから何件の要点を役に渡すか
  it('says the count of reference images is how many gists the roles get, newest first', () => {
    const label = budgetLabel('references.maxCount');

    expect(label).toContain('要点の件数');
    expect(label).toContain('新しいものから');
    expect(label).not.toContain('枚数');
  });
});
