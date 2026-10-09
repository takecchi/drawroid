import type { PackLimits } from '../../budget/pack.js';
import type { MemoryRoleLimits } from '../select.js';

export type DistillBudget = {
  /** 依頼の要点（口出しは統合済み） */
  intentChars: number;
  /** 止まった理由の短い説明 */
  stopDetailChars: number;
  /** 口出しの原文の件数と、文字数の合計（maxSize） */
  interventions: PackLimits;
  /** 口出し1件の原文 */
  interventionChars: number;
  /** 選択・却下の件数 */
  selections: PackLimits;
  /** 選択・却下1件に添える評価の問題点の件数と、1件の文字数 */
  issuesPerSelection: number;
  issueChars: number;
  /** 既存の項目。always は別枠 */
  memory: MemoryRoleLimits;
  /** 出力の上限 */
  output: {
    operations: number;
    body: number;
    tags: number;
    tag: number;
  };
};

// 値は仮置き。設定（config.json の budgets）の既定値として、実測で見直す
export const DEFAULT_DISTILL_BUDGET: DistillBudget = {
  intentChars: 600,
  stopDetailChars: 120,
  interventions: { maxCount: 8, maxSize: 800 },
  interventionChars: 200,
  selections: { maxCount: 8 },
  issuesPerSelection: 3,
  issueChars: 80,
  memory: { maxCount: 10, maxSize: 500, always: { maxCount: 6, maxSize: 300 } },
  output: { operations: 5, body: 80, tags: 4, tag: 20 },
};
