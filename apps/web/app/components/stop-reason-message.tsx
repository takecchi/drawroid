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
    // 要約で次の手を言い当てない: 止まった理由のデータに待てば直るかの印は無く、detail の文を画面で読み直すと、
    // 言い方が変わるたびにずれるため。次の手は、失敗の種類ごとに言い分けた detail に任せる
    return (
      <ErrorNote className="space-y-1">
        <p>
          <strong>{llm}。</strong>何をすればよいかは、すぐ下の詳しい理由にある。{' '}
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
