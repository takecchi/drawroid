import type { InstructionIntervention, InterventionRecord } from '../job/types.js';

/** 1回の「考える」に載せる口出しの件数と文字数（maxSize は原文の文字数の合計、textEach は1件の文字数） */
export type InterventionLimits = {
  maxCount: number;
  maxSize: number;
  textEach: number;
};

// 値は仮置き。設定（config.json の budgets）の既定値として、実測で見直す
export const DEFAULT_INTERVENTION_LIMITS: InterventionLimits = {
  maxCount: 3,
  maxSize: 400,
  textEach: 200,
};

/** 人間の指示のうち、まだ「考える」に取り込んでいないものを、受けた順に返す */
export function pendingInterventions(
  interventions: readonly InterventionRecord[],
): InstructionIntervention[] {
  return interventions
    .filter(
      (intervention): intervention is InstructionIntervention =>
        intervention.kind === 'instruction' && intervention.appliedInIteration === undefined,
    )
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}
