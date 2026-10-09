import type { BudgetOverridesInput } from '@drawroid/swr';

type Tree = { [key: string]: number | Tree };

export interface BudgetLeaf {
  /** 鍵のパス（例: memory.think.maxCount）。欄の名前になる */
  path: string;
  defaultValue: number;
}

/** 既定値の木の葉を、画面に出す順に並べる。木の形は既定値が決める */
export function budgetLeaves(defaults: object, prefix = ''): BudgetLeaf[] {
  return Object.entries(defaults as Tree).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return typeof value === 'number' ? [{ path, defaultValue: value }] : budgetLeaves(value, path);
  });
}

// 文字列で持つ: 入力の途中の空欄や数字でない文字を、数に直すと消えてしまうため
export type BudgetFormValues = Record<string, string>;

/** 書いてある上書きを、欄の値にする。数でないものは欄に出さない（保存すると外れる） */
export function toBudgetFormValues(overrides: unknown): BudgetFormValues {
  const values: BudgetFormValues = {};
  const walk = (node: unknown, prefix: string) => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof value === 'number') values[path] = String(value);
      else walk(value, path);
    }
  };
  walk(overrides, '');
  return values;
}

export type BudgetFormResult =
  | { ok: true; overrides: BudgetOverridesInput }
  | { ok: false; errors: { path: string; reason: string }[] };

/**
 * 欄の値から、送る上書きの木を組み立てる。空欄は書かない（既定のまま）。
 * 範囲は API が断るので、ここでは「整数か」「1 以上か」だけを見る
 */
export function buildBudgetOverrides(values: BudgetFormValues): BudgetFormResult {
  const errors: { path: string; reason: string }[] = [];
  const root: Tree = {};
  for (const [path, text] of Object.entries(values)) {
    const trimmed = text.trim();
    if (trimmed === '') continue;
    const value = Number(trimmed);
    if (!Number.isInteger(value)) {
      errors.push({ path, reason: '整数で入れる' });
      continue;
    }
    if (value < 1) {
      errors.push({ path, reason: '1 以上で入れる' });
      continue;
    }
    const keys = path.split('.');
    const leaf = keys.pop() as string;
    let node = root;
    // 自分の欄だけをたどる: 手で書いた config.json の __proto__ などの鍵で、Object.prototype へ書かないため
    for (const key of keys) {
      if (!Object.hasOwn(node, key)) node[key] = {};
      node = node[key] as Tree;
    }
    node[leaf] = value;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, overrides: root as BudgetOverridesInput };
}
