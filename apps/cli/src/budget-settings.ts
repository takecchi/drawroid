import type { BudgetSettingsPort } from '@drawroid/api';
import { budgetOverridesSchema, resolveBudgets } from '@drawroid/core';
import { readBudgetSettings, writeBudgetSettings } from '@drawroid/storage-fs';

/**
 * config.json の budgets を、読むたびに検証して既定に重ねる。
 * 書き換えたら次に投入するジョブから効く。走っているジョブには届けない。
 */
export function createBudgetSettings(configPath: string): BudgetSettingsPort {
  return {
    read: async () => {
      const overrides = (await readBudgetSettings(configPath)) ?? {};
      const parsed = budgetOverridesSchema.safeParse(overrides);
      // 読めない予算を既定で置き換えない: 人間が書いたはずの予算が効いていないまま、ジョブが投入されるため
      if (!parsed.success) {
        const reason = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(budgets)'}: ${issue.message}`)
          .join('; ');
        throw new Error(`config.json の budgets が不正: ${reason}`);
      }
      return { overrides: parsed.data, effective: resolveBudgets(parsed.data) };
    },
    write: async (overrides) => {
      await writeBudgetSettings(configPath, overrides);
      return resolveBudgets(overrides);
    },
  };
}
