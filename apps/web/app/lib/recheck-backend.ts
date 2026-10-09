import type { StopReason } from '@drawroid/core';
import { recheckBackendStatus } from '@drawroid/swr';
import { useEffect } from 'react';

/** バックエンドの失敗で止まったか（止まった理由に、バックエンドの失敗の種類が付いている） */
export function stoppedByBackend(reason: StopReason): boolean {
  return reason.kind === 'error' && reason.backendErrorKind !== undefined;
}

/**
 * バックエンドの失敗で止まったジョブを見たら、バックエンドの状態を1回読み直す。failureKey が新しい値に変わるたびに1回。
 * 読めなければ「繋がらない」の案内が出て、繋がらない間の読み直し（useBackendStatus）が続く
 */
// 止まったジョブの鍵で1回にする: 増分や別のイベントで描き直すたびに読み直すと、バックエンドへの問い合わせが増えるため
export function useRecheckBackendOnFailure(failureKey: string | undefined): void {
  useEffect(() => {
    if (failureKey !== undefined) void recheckBackendStatus();
  }, [failureKey]);
}
