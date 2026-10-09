import { readConfigObject, updateConfigObject } from './config-file.js';

/** config.json の budgets キー（予算のうち、書いた欄だけ）。ファイルかキーが無ければ undefined */
export async function readBudgetSettings(configPath: string): Promise<unknown | undefined> {
  return (await readConfigObject(configPath)).budgets;
}

// budgets 以外のキーを保つ: config.json には LLM やバックエンド・許可の設定も入るため、丸ごと書き換えると消える
export async function writeBudgetSettings(configPath: string, overrides: unknown): Promise<void> {
  await updateConfigObject(configPath, (current) => ({ ...current, budgets: overrides }));
}
