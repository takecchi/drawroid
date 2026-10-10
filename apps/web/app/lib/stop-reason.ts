import type { StopReason } from '@drawroid/core';

import { backendSubject, describeBackendError, type BackendKind } from './backend-error';

// Record にする: 止まった理由の種類が増えたとき、言葉を足し忘れると型で落ちるため
const SUMMARIES: Record<Exclude<StopReason['kind'], 'error'>, string> = {
  ai: 'AI が意図どおりと判断',
  'limit:iterations': '回数の上限',
  'limit:duration': '時間の上限',
  'limit:images': '枚数の上限',
  human: '人が止めた',
  adopted: '人が画像を選んだ',
};

/**
 * LLM の役が失敗して止まったときの、その段の言い方。実行器は止まった理由（detail）の頭に、どの段で止まったかを書く。
 * LLM の段でなければ undefined
 */
// 頭の言葉で見分ける: 止まった理由の記録には段の欄が無く、言葉は実行器（runner.ts）の StopJob が書く
const LLM_STAGES: readonly [string, string][] = [
  ['考える段: ', '考える役（LLM）が失敗した'],
  ['見る段: ', '見る役（LLM）が失敗した'],
  ['参照画像の要点: ', '見る役（LLM）が参照画像を読めなかった'],
];
export function llmStageFailure(reason: StopReason): string | undefined {
  if (reason.kind !== 'error' || reason.backendErrorKind !== undefined) return undefined;
  return LLM_STAGES.find(([head]) => reason.detail.startsWith(head))?.[1];
}

// ジョブの記録には繋いでいたバックエンドの種類が残らないので、いま使っている種類で言う
export function summarizeStopReason(reason: StopReason, backendKind?: BackendKind): string {
  if (reason.kind !== 'error') return SUMMARIES[reason.kind];
  const llm = llmStageFailure(reason);
  if (llm !== undefined) return llm;
  if (reason.backendErrorKind === undefined) return `${backendSubject(backendKind)}の外で失敗した`;
  return (
    describeBackendError(reason.backendErrorKind, backendKind)?.summary ??
    `失敗した（${reason.backendErrorKind}）`
  );
}
