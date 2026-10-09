import type { PackLimits } from '../../budget/pack.js';

/** 話す役の1回の入力と、ツールの結果の予算 */
export type TalkLimits = {
  /** 直近のやりとりとして渡す発言の件数（人間と話す役を合わせて）。これより前の発言は渡さない */
  recentMessages: number;
  /** 発言1件の文字数 */
  messageChars: number;
  /** 会話のジョブの状態の欄の文字数 */
  jobChars: number;
  /** 1ターンのステップ数の上限。最後のステップはツールを渡さず、返答させる */
  maxSteps: number;
  /** ツールの結果1件の文字数（話す役へ返す分） */
  toolResultChars: number;
  /** search_candidates が返す候補の件数・文字数 */
  candidates: Required<PackLimits>;
  /** recall_memory が返す記憶の件数・文字数 */
  memory: Required<PackLimits>;
};

// 値は仮置き。設定（config.json の budgets.talk）の既定値として、実測で見直す
export const DEFAULT_TALK_LIMITS: TalkLimits = {
  recentMessages: 12,
  messageChars: 600,
  jobChars: 600,
  maxSteps: 6,
  toolResultChars: 800,
  candidates: { maxCount: 20, maxSize: 600 },
  memory: { maxCount: 8, maxSize: 600 },
};
