import { describe, expect, it } from 'vitest';

import {
  budgetLeafMinimum,
  DEFAULT_BUDGETS,
  resolveBudgets,
  type Budgets,
} from '../budget/settings.js';
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

  // 断る理由に、どの欄を減らせばよいかを添える: 欄を1つだけいちばん小さくしたとき、その段の削れない部分がいちばん減る欄
  describe('naming the field to reduce', () => {
    const tiny: ModelWindow = { contextTokens: 100, maxOutputTokens: 0 };
    const fieldOf = (overflows: ReturnType<typeof findInputOverflows>, stage: string) =>
      overflows.find((o) => o.stage === stage)?.largestField?.path;

    it('names the field that takes the most of the stage', () => {
      const overflows = findInputOverflows(
        resolveBudgets({ candidates: { maxSize: 12000 }, references: { noteChars: 2000 } }),
        { think: tiny },
      );

      expect(fieldOf(overflows, 'think')).toBe('candidates.maxSize');
      expect(fieldOf(overflows, 'ref-gist')).toBe('references.noteChars');
    });

    // 段ごとに選ぶ: 窓を超えた段ごとに、その段の削れない部分を減らす欄は違うため
    it('names a field for each stage on its own', () => {
      const overflows = findInputOverflows(
        resolveBudgets({ candidates: { maxSize: 12000 }, imageLongEdge: 1536, imagesPerJudge: 8 }),
        { think: tiny, judge: tiny },
      );

      expect(fieldOf(overflows, 'think')).toBe('candidates.maxSize');
      expect(fieldOf(overflows, 'judge')).toBe('imageLongEdge');
      // 保存できない値までは下げない: 画像の長辺は 128 より小さく保存できないため
      expect(overflows.find((o) => o.stage === 'judge')?.largestField?.smallest).toBe(128);
    });

    // どの欄を小さくしても減らないなら、欄を挙げない: 段が読む欄がもう最小で、読まない欄だけが大きいとき
    it('names no field when making any field the smallest frees nothing', () => {
      const atMinimum = (node: object, prefix = ''): object =>
        Object.fromEntries(
          Object.entries(node).map(([key, value]) => {
            const path = prefix === '' ? key : `${prefix}.${key}`;
            if (typeof value === 'number') return [key, budgetLeafMinimum(path)];
            return [
              key,
              value !== null && typeof value === 'object' ? atMinimum(value, path) : value,
            ];
          }),
        );
      const smallest = atMinimum(DEFAULT_BUDGETS) as Budgets;
      const budgets: Budgets = { ...smallest, talk: { ...smallest.talk, messageChars: 100000 } };

      const overflows = findInputOverflows(budgets, { think: tiny, judge: tiny });

      expect(overflows).not.toEqual([]);
      for (const overflow of overflows) {
        expect(overflow.largestField).toBeUndefined();
        expect(describeInputOverflow(overflow)).not.toContain('いちばん大きく効いている欄');
      }
    });

    // 値の大きさでは選ばない: その段が読まない欄は、どれだけ大きくても減らしても窓に入らないため
    it('does not name a field the stage does not read, however large it is', () => {
      const overflows = findInputOverflows(
        resolveBudgets({
          memory: { think: { maxSize: 100000 } },
          distill: { memory: { maxSize: 100000 } },
          talk: { messageChars: 100000 },
        }),
        { think: tiny, judge: tiny },
      );

      expect(overflows).not.toEqual([]);
      for (const overflow of overflows) {
        expect(overflow.largestField?.path).toMatch(
          /^(text|candidates|interventions|references|image)/,
        );
      }
    });

    it('says how many tokens the field frees when it is made the smallest', () => {
      const budgets = resolveBudgets({ candidates: { maxSize: 12000 } });
      const [think] = findInputOverflows(budgets, { think: tiny });
      const smallest = findInputOverflows(resolveBudgets({ candidates: { maxSize: 1 } }), {
        think: tiny,
      })[0]!;

      expect(think!.largestField).toEqual({
        path: 'candidates.maxSize',
        smallest: 1,
        savedTokens: think!.requiredTokens - smallest.requiredTokens,
      });
      const line = describeInputOverflow(think!);
      expect(line).toContain('candidates.maxSize');
      expect(line).toContain(`${think!.largestField!.savedTokens} トークン減る`);
    });

    // 欄の名前に括弧を続けない: 画面が名前を「見出し（内部名）」に置き換えても、括弧が二重に続かないため
    it('does not put a parenthesis right after the name of the field', () => {
      const [think] = findInputOverflows(resolveBudgets({ candidates: { maxSize: 12000 } }), {
        think: tiny,
      });

      const line = describeInputOverflow(think!);
      expect(line).toContain(`欄は ${think!.largestField!.path}。`);
      expect(line).not.toContain(`${think!.largestField!.path}（`);
    });
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
