import { estimateTextTokens } from '../budget/estimate.js';
import type { LlmRole } from '../llm/port.js';
import type { Budget } from './budget.js';

/**
 * 役ごとの出力の大きさの見積もり（トークン）。出力スキーマの文字数の上限まで埋めたときの値で、
 * 考える役は口出しを載せた回（依頼の要点も出す）、見る役は1回に載せる画像の枚数ぶんの評価を数える。
 * 考える役のパラメータは M2 の可動範囲（prompt・negativePrompt・seed・steps・CFG）だけを数えるので、
 * 許可で LoRA などを任せると、実際はこれより大きくなる（下限の見積もり）。
 */
// 英数字は prompt・negativePrompt だけで、理由・要点・問題点・次に変えることは日本語で書かれるものとして数える。
// 日本語のほうが1文字あたりのトークンが多く、上限を小さく見積もらないため
export function estimateMaxOutputTokens(budget: Budget): Record<LlmRole, number> {
  const ja = (n: number) => 'あ'.repeat(n);
  const think = {
    params: {
      prompt: 'a'.repeat(budget.text.prompt),
      negativePrompt: 'a'.repeat(budget.text.negativePrompt),
      seed: 4294967295,
      steps: 150,
      cfgScale: 30,
    },
    rationale: ja(budget.text.rationale),
    intent: ja(budget.text.intent),
  };
  const judge = {
    images: Array.from({ length: budget.imagesPerJudge }, () => ({
      score: 0.55,
      issues: Array.from({ length: budget.issuesPerImage }, () => ja(budget.text.issue)),
    })),
    nextChange: ja(budget.text.nextChange),
    canStop: false,
  };
  return {
    think: estimateTextTokens(JSON.stringify(think)),
    judge: estimateTextTokens(JSON.stringify(judge)),
  };
}
