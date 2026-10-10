// @vitest-environment jsdom
import type { StopReason } from '@drawroid/core';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StopReasonMessage } from './stop-reason-message';

// 繋いでいるバックエンドの種類は、LLM の失敗の言い方に関わらない
vi.mock('../lib/use-backend-kind', () => ({ useBackendKind: () => 'forge' }));

afterEach(cleanup);

const renderReason = (reason: StopReason) =>
  render(
    <MemoryRouter>
      <StopReasonMessage reason={reason} />
    </MemoryRouter>,
  );

const UNSUPPORTED: StopReason = {
  kind: 'error',
  detail:
    '見る段: LLM の呼び出しに失敗した: LLM のサーバが、この使い方に対応していないと返した（500）。待っても直らない。LLM の設定で、その役のモデルと、構造化出力・ツールの呼び出し方・画像を読めるかを、モデルに合わせて見直す（LLM の返した理由: image input is not supported）',
};

const PASSING: StopReason = {
  kind: 'error',
  detail:
    '考える段: LLM の呼び出しに失敗した: LLM のサーバが失敗を返した（503）。少し待ってから、もう一度頼む（LLM の返した理由: overloaded）',
};

describe('StopReasonMessage, when an LLM stage failed', () => {
  // 止まった理由のデータには、待てば直るかの印が無い。要約で待つよう促すと、待っても直らない失敗（画像を読めないモデルなど）と食い違うため、
  // 次の手は、失敗の種類ごとに言い分けたすぐ下の詳しい理由に任せる
  it('names the stage and points to the detailed reason below, without telling to wait', () => {
    renderReason(UNSUPPORTED);

    const summary = screen.getByText('見る役（LLM）が失敗した。').closest('p');
    expect(summary?.textContent).toContain('何をすればよいかは、すぐ下の詳しい理由にある');
    expect(summary?.textContent).not.toContain('待って');
  });

  it('keeps the detailed reason as written and the way to the LLM settings', () => {
    renderReason(PASSING);

    expect(screen.getByText(PASSING.detail)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'LLM の設定へ' }).getAttribute('href')).toBe(
      '/settings#llm',
    );
    expect(screen.getByText('考える役（LLM）が失敗した。')).toBeTruthy();
  });
});
