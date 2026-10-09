import {
  budgetOverridesSchema,
  DEFAULT_BUDGETS,
  type BudgetOverrides,
  type Budgets,
} from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { invalidConfig } from '../errors.js';
import { jsonBody } from '../validate.js';

/**
 * 予算の設定。書いた欄（overrides）と、既定に重ねた実際の値（effective）と、既定（defaults）を返す。
 * 書いた予算は、そのあとに投入するジョブから効く。走っている・待っているジョブの job.json の budgets は変わらない。
 */
export function budgetSettingsRoutes({ budgetSettings }: ApiDeps) {
  const view = (overrides: unknown, effective: Budgets) => ({
    overrides,
    effective,
    defaults: DEFAULT_BUDGETS,
  });

  return new Hono()
    .get('/', async (c) => {
      // 読めない設定を、既定だけで答えない: 人間が書いたはずの予算が効いていないことが見えなくなるため
      try {
        const { overrides, effective } = await budgetSettings.read();
        return c.json(view(overrides, effective), 200);
      } catch (error) {
        return invalidConfig(c, error instanceof Error ? error.message : String(error));
      }
    })
    .put('/', jsonBody(budgetOverridesSchema), async (c) => {
      const overrides: BudgetOverrides = c.req.valid('json');
      const effective = await budgetSettings.write(overrides);
      return c.json(view(overrides, effective), 200);
    });
}
