import {
  budgetOverridesSchema,
  DEFAULT_BUDGETS,
  resolveBudgets,
  type BudgetOverrides,
  type Budgets,
  type InvalidBudget,
} from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { invalidConfig, invalidRequest } from '../errors.js';
import { windowProblem } from '../input-windows.js';
import { jsonBody } from '../validate.js';

/**
 * 予算の設定。書いた欄のうち読めたもの（overrides）と、既定に重ねた実際の値（effective）と、既定（defaults）と、
 * 読めずに既定に戻した欄（invalid: 道筋と理由）を返す。
 * 書いた予算は、そのあとに投入するジョブから効く。走っている・待っているジョブの job.json の budgets は変わらない。
 */
export function budgetSettingsRoutes(deps: ApiDeps) {
  const { budgetSettings } = deps;
  const view = (overrides: unknown, effective: Budgets, invalid: InvalidBudget[]) => ({
    overrides,
    effective,
    defaults: DEFAULT_BUDGETS,
    invalid,
  });

  return new Hono()
    .get('/', async (c) => {
      // 読めない欄は既定に戻して答え、どの欄が効いていないかを invalid で見せる。config.json そのものが読めないときだけ断る
      try {
        const { overrides, effective, invalid } = await budgetSettings.read();
        return c.json(view(overrides, effective, invalid), 200);
      } catch (error) {
        return invalidConfig(c, error instanceof Error ? error.message : String(error));
      }
    })
    .put('/', jsonBody(budgetOverridesSchema), async (c) => {
      // 書く本文は厳しく検証するので、書いた直後に読めない欄は無い
      const overrides: BudgetOverrides = c.req.valid('json');
      // 窓に入らない予算は保存しない: 保存すると、次に投入するジョブが入力を組む段で必ず止まるため（architecture の予算）
      const problem = await windowProblem(deps, resolveBudgets(overrides));
      if (problem !== undefined) return invalidRequest(c, problem);
      const effective = await budgetSettings.write(overrides);
      return c.json(view(overrides, effective, []), 200);
    });
}
