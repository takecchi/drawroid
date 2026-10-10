import type { StopReason } from '@drawroid/core';
import { ErrorNote } from '@drawroid/ui';
import { Link } from 'react-router';

import { llmStageFailure, summarizeStopReason } from '../lib/stop-reason';
import { useBackendKind } from '../lib/use-backend-kind';
import { BackendErrorMessage } from './backend-error-message';

// error 以外は要約だけで足りる: detail は人間向けの短い説明で、要約と重なるため
export function StopReasonMessage({ reason }: { reason: StopReason }) {
  const backendKind = useBackendKind();
  if (reason.kind !== 'error')
    return <p>止まった理由: {summarizeStopReason(reason, backendKind)}</p>;
  const llm = llmStageFailure(reason);
  if (llm !== undefined) {
    return (
      <ErrorNote className="space-y-1">
        <p>
          <strong>{llm}。</strong>LLM
          の設定（鍵・接続先・モデル）を確かめるか、少し待ってから描き直す。{' '}
          <Link to="/settings#llm" className="text-primary underline-offset-4 hover:underline">
            LLM の設定へ
          </Link>
        </p>
        <p>
          <code>{reason.detail}</code>
        </p>
      </ErrorNote>
    );
  }
  if (reason.backendErrorKind === undefined) {
    return (
      <ErrorNote className="space-y-1">
        <p>
          <strong>{summarizeStopReason(reason, backendKind)}（結果の保存など）。</strong>
        </p>
        <p>
          <code>{reason.detail}</code>
        </p>
      </ErrorNote>
    );
  }
  return <BackendErrorMessage kind={reason.backendErrorKind} message={reason.detail} />;
}
