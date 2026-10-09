import type { BudgetSettingsPort } from '@drawroid/api';
import { readBudgetOverrides, resolveBudgets } from '@drawroid/core';
import { readBudgetSettings, writeBudgetSettings } from '@drawroid/storage-fs';

/**
 * config.json の budgets を、読むたびに欄ごとに検証して既定に重ねる。読めない欄は既定に戻し、理由を返す。
 * 読めない欄が変わったときだけ log に出す（直ったときも出す）。
 * 書き換えたら次に投入するジョブから効く。走っているジョブには届けない。
 */
// 1 か所の書き損じで投入を止めない（許可の #100 と同じ作り）: 効いていない欄は、ログと設定の口（invalid）で見える
export function createBudgetSettings(
  configPath: string,
  log: (line: string) => void = () => undefined,
): BudgetSettingsPort {
  let reported = '';
  return {
    read: async () => {
      const { overrides, invalid } = readBudgetOverrides(await readBudgetSettings(configPath));
      const now = invalid.map((i) => `${i.path}: ${i.reason}`).join('; ');
      if (now !== reported) {
        log(
          now === ''
            ? 'drawroid: config.json の budgets がすべて読めるようになった'
            : `drawroid: config.json の budgets に読めない欄があり、既定に戻した: ${now}`,
        );
        reported = now;
      }
      return { overrides, effective: resolveBudgets(overrides), invalid };
    },
    write: async (overrides) => {
      await writeBudgetSettings(configPath, overrides);
      return resolveBudgets(overrides);
    },
  };
}
