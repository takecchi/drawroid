import { describe, expect, it } from 'vitest';

import { DEFAULT_BUDGETS, resolveBudgets } from '../budget/settings.js';
import { DEFAULT_MODEL_WINDOW, type ModelWindow } from './budget.js';
import { describeInputOverflow, findInputOverflows } from './window-fit.js';

const roomy: ModelWindow = DEFAULT_MODEL_WINDOW;

describe('findInputOverflows', () => {
  it('finds nothing for the default budgets in the default window', () => {
    expect(findInputOverflows(DEFAULT_BUDGETS, { think: roomy, judge: roomy })).toEqual([]);
  });

  it('names the role, the stage, the window and how much it is over', () => {
    const small: ModelWindow = { contextTokens: 1500, maxOutputTokens: 500 };
    const overflows = findInputOverflows(DEFAULT_BUDGETS, { think: small, judge: roomy });

    const think = overflows.find((o) => o.stage === 'think');
    expect(think).toMatchObject({ role: 'think', inputTokenLimit: 1000, window: small });
    expect(think!.requiredTokens).toBeGreaterThan(1000);
    expect(think!.over).toBe(think!.requiredTokens - 1000);
    expect(overflows.every((o) => o.role === 'think')).toBe(true);

    const line = describeInputOverflow(think!);
    expect(line).toContain('考える役');
    expect(line).toContain('考える段');
    expect(line).toContain('1500');
    expect(line).toContain('500');
    expect(line).toContain(`${think!.over} トークン超える`);
  });

  // 和と入力に使える分が等しければ、入力は組める（seal は超えたときだけ落とす）
  it('lets the sum through when it equals what the window leaves for the input, and not one token less', () => {
    const [probe] = findInputOverflows(DEFAULT_BUDGETS, {
      think: { contextTokens: 100, maxOutputTokens: 0 },
    }).filter((o) => o.stage === 'think');
    const needed = probe!.requiredTokens;

    expect(
      findInputOverflows(DEFAULT_BUDGETS, {
        think: { contextTokens: needed + 300, maxOutputTokens: 300 },
      }).filter((o) => o.stage === 'think'),
    ).toEqual([]);
    expect(
      findInputOverflows(DEFAULT_BUDGETS, {
        think: { contextTokens: needed + 299, maxOutputTokens: 300 },
      }).filter((o) => o.stage === 'think'),
    ).toEqual([expect.objectContaining({ over: 1 })]);
  });

  // 考える役は2つの呼び出し（考える段・参照画像の要点を読む段）で入力を組む。どちらも同じ窓に入らなければならない
  it('checks the stage that reads the reference image gists, too, against the thinking role window', () => {
    const tiny: ModelWindow = { contextTokens: 100, maxOutputTokens: 0 };
    const overflows = findInputOverflows(DEFAULT_BUDGETS, { think: tiny });

    expect(overflows.map((o) => o.stage)).toEqual(['think', 'ref-gist']);
    const gist = overflows.find((o) => o.stage === 'ref-gist')!;
    expect(gist).toMatchObject({ role: 'think', inputTokenLimit: 100, window: tiny });
    expect(describeInputOverflow(gist)).toContain('参照画像の要点を読む段');

    // 要点の段にちょうど入る窓なら、その段は挙げない
    const fits = gist.requiredTokens;
    expect(
      findInputOverflows(DEFAULT_BUDGETS, {
        think: { contextTokens: fits, maxOutputTokens: 0 },
      }).map((o) => o.stage),
    ).not.toContain('ref-gist');
  });

  // 窓の分からない役は比べない: 分かっている値でだけ比べ、分からない役は呼び手が知らせる
  it('leaves out the roles whose window is not known, however large their budget is', () => {
    const heavyJudge = resolveBudgets({ imagesPerJudge: 8, imageLongEdge: 1536 });
    expect(findInputOverflows(heavyJudge, { think: roomy })).toEqual([]);
    expect(
      findInputOverflows(heavyJudge, { think: roomy, judge: roomy }).map((o) => o.stage),
    ).toEqual(['judge']);
  });

  it('counts more for the thinking stage when the candidates may take more', () => {
    const tiny = { think: { contextTokens: 10, maxOutputTokens: 0 } };
    const base = findInputOverflows(DEFAULT_BUDGETS, tiny).find((o) => o.stage === 'think')!;
    const wider = findInputOverflows(
      resolveBudgets({ candidates: { maxSize: DEFAULT_BUDGETS.candidates.maxSize! + 100 } }),
      tiny,
    ).find((o) => o.stage === 'think')!;
    expect(wider.requiredTokens).toBeGreaterThan(base.requiredTokens);
  });
});
