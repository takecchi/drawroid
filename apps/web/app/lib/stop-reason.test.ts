import { STOP_REASON_KINDS, type StopReason } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { describeBackendError } from './backend-error';
import { summarizeStopReason } from './stop-reason';

describe('summarizeStopReason', () => {
  it.each(STOP_REASON_KINDS)('gives a non-empty summary for %s', (kind) => {
    expect(summarizeStopReason({ kind, detail: 'x' })).toBeTruthy();
  });

  it('says the AI judged the intent met', () => {
    expect(summarizeStopReason({ kind: 'ai', detail: '' })).toBe('AI が意図どおりと判断');
  });

  it('says an iteration limit was hit', () => {
    expect(summarizeStopReason({ kind: 'limit:iterations', detail: '' })).toBe('回数の上限');
  });

  it('uses the backend error summary when the failure came from the backend', () => {
    const reason: StopReason = { kind: 'error', detail: 'x', backendErrorKind: 'unreachable' };
    expect(summarizeStopReason(reason)).toBe(describeBackendError('unreachable')?.summary);
  });

  it('says the failure was outside Forge when there is no backend error kind', () => {
    expect(summarizeStopReason({ kind: 'error', detail: 'disk full' })).toBe(
      'Forge の外で失敗した',
    );
  });
});
