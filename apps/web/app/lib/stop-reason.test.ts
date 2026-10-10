import { LLM_CALL_FAILED_PREFIX, STOP_REASON_KINDS, type StopReason } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { describeBackendError } from './backend-error';
import { llmStageFailure, summarizeStopReason } from './stop-reason';

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

// 実行器は、LLM の段で止まったとき、理由の頭に段の名前を書く（runner.ts の StopJob）。続く文は LLM の呼び出しの失敗の言葉
describe('llmStageFailure', () => {
  const failed = `${LLM_CALL_FAILED_PREFIX}鍵が通らない（401）。LLM の設定の API キーの環境変数と、その値を確かめる（LLM の返した理由: Incorrect API key provided）`;

  it.each([
    [`考える段: ${failed}`, '考える役（LLM）が失敗した'],
    ['考える段: 出力が形に合わない', '考える役（LLM）が失敗した'],
    [`見る段: ${failed}`, '見る役（LLM）が失敗した'],
    [`参照画像の要点: ${failed}`, '見る役（LLM）が参照画像を読めなかった'],
  ])('names the role that failed when the job stopped at %s', (detail, said) => {
    const reason: StopReason = { kind: 'error', detail };
    expect(llmStageFailure(reason)).toBe(said);
    expect(summarizeStopReason(reason)).toBe(said);
  });

  it.each([
    { kind: 'error', detail: '生成の要求を組む段: 形が違う' },
    { kind: 'error', detail: '生成の段: 繋がらない', backendErrorKind: 'unreachable' },
    { kind: 'ai', detail: '考える段: のように見える文' },
  ] satisfies StopReason[])('does not blame the LLM for %o', (reason) => {
    expect(llmStageFailure(reason)).toBeUndefined();
  });
});
