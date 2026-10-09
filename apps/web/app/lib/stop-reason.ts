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

// ジョブの記録には繋いでいたバックエンドの種類が残らないので、いま使っている種類で言う
export function summarizeStopReason(reason: StopReason, backendKind?: BackendKind): string {
  if (reason.kind !== 'error') return SUMMARIES[reason.kind];
  if (reason.backendErrorKind === undefined) return `${backendSubject(backendKind)}の外で失敗した`;
  return (
    describeBackendError(reason.backendErrorKind, backendKind)?.summary ??
    `失敗した（${reason.backendErrorKind}）`
  );
}
