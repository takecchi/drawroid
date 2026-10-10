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
  // 待っても直らない失敗にも、待てば直る失敗にも同じ文を出す: 「待って」の有無だけを見ると、言い換えて待たせる文や、detail を読んで出し分ける文が通るため
  it.each([
    ['cannot be fixed by waiting', UNSUPPORTED, '見る役（LLM）が失敗した。'],
    ['can be fixed by waiting', PASSING, '考える役（LLM）が失敗した。'],
  ])(
    'names the stage and only points to the detailed reason below, when the failure %s',
    (_, reason, stage) => {
      renderReason(reason);

      expect(screen.getByText(stage).closest('p')?.textContent).toBe(
        `${stage}何をすればよいかは、すぐ下の詳しい理由にある。 LLM の設定へ`,
      );
    },
  );

  it('keeps the detailed reason as written and the way to the LLM settings', () => {
    renderReason(PASSING);

    expect(screen.getByText(PASSING.detail)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'LLM の設定へ' }).getAttribute('href')).toBe(
      '/settings#llm',
    );
    expect(screen.getByText('考える役（LLM）が失敗した。')).toBeTruthy();
  });
});
