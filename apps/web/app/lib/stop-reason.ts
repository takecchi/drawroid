import type { StopReason } from '@drawroid/core';

import { describeBackendError } from './backend-error';

// Record にする: 止まった理由の種類が増えたとき、言葉を足し忘れると型で落ちるため
const SUMMARIES: Record<Exclude<StopReason['kind'], 'error'>, string> = {
  ai: 'AI が意図どおりと判断',
  'limit:iterations': '回数の上限',
  'limit:duration': '時間の上限',
  'limit:images': '枚数の上限',
  human: '人が止めた',
};

const OUTSIDE_BACKEND = 'Forge の外で失敗した';

export function summarizeStopReason(reason: StopReason): string {
  if (reason.kind !== 'error') return SUMMARIES[reason.kind];
  if (reason.backendErrorKind === undefined) return OUTSIDE_BACKEND;
  return (
    describeBackendError(reason.backendErrorKind)?.summary ??
    `失敗した（${reason.backendErrorKind}）`
  );
}
