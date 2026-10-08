/** 人間の口出し1件。AI の判断とは別に、受けた原文のまま記録する */
export type Intervention = {
  id: string;
  receivedAt: string;
  text: string;
  /** 「考える」に取り込んだ回。未反映の間は無い */
  appliedInIteration?: number;
};

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

/** まだ「考える」に取り込んでいない口出しを、受けた順に返す */
export function pendingInterventions(interventions: readonly Intervention[]): Intervention[] {
  return interventions
    .filter((intervention) => intervention.appliedInIteration === undefined)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}
