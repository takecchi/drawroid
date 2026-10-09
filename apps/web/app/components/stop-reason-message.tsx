import type { StopReason } from '@drawroid/core';

import { summarizeStopReason } from '../lib/stop-reason';
import { BackendErrorMessage } from './backend-error-message';

// error 以外は要約だけで足りる: detail は人間向けの短い説明で、要約と重なるため
export function StopReasonMessage({ reason }: { reason: StopReason }) {
  if (reason.kind !== 'error') return <p>止まった理由: {summarizeStopReason(reason)}</p>;
  if (reason.backendErrorKind === undefined) {
    return (
      <div role="alert">
        <p>
          <strong>{summarizeStopReason(reason)}（結果の保存など）。</strong>
        </p>
        <p>
          <code>{reason.detail}</code>
        </p>
      </div>
    );
  }
  return <BackendErrorMessage kind={reason.backendErrorKind} message={reason.detail} />;
}
