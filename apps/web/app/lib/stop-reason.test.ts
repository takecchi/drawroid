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

  it('names the chosen backend in the backend error summary', () => {
    const reason: StopReason = { kind: 'error', detail: 'x', backendErrorKind: 'unreachable' };
    expect(summarizeStopReason(reason, 'a1111')).toBe('A1111 に繋がらない。');
  });

  it('says the failure was outside A1111 when A1111 is chosen', () => {
    expect(summarizeStopReason({ kind: 'error', detail: 'disk full' }, 'a1111')).toBe(
      'A1111 の外で失敗した',
    );
  });

  it('says the failure was outside the backend, naming none, when the chosen one is unknown', () => {
    expect(summarizeStopReason({ kind: 'error', detail: 'disk full' })).toBe(
      'バックエンド（Forge / A1111）の外で失敗した',
    );
  });

  it('says the failure was outside Forge when there is no backend error kind', () => {
    expect(summarizeStopReason({ kind: 'error', detail: 'disk full' }, 'forge')).toBe(
      'Forge の外で失敗した',
    );
  });
});
