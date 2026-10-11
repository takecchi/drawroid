import { Disclosure, Page } from '@drawroid/ui';
import { useEffect } from 'react';
import { useLocation } from 'react-router';

import { BackendStatus } from '../components/backend-status';
import { BackendUrlSettings } from '../components/backend-url-settings';
import { BudgetInvalidNotice, BudgetSettings } from '../components/budget-settings';
import { DoctorCheck } from '../components/doctor-check';
import { GenerationProgressSettings } from '../components/generation-progress-settings';
import { LlmSettings } from '../components/llm-settings';

/**
 * 設定。初めての人が要るもの（画像のバックエンドと LLM）を上に置き、予算は「詳しい設定」として畳む。
 * 一番下に、全部をまとめて確かめる「確かめる」（drawroid doctor と同じ確かめ）を置く: 上で設定してから押すため。
 * 生成の途中の画像（#generation-progress）は、会話で何が見えるかの設定なので、LLM の下・詳しい設定の上に畳まずに置く。
 * 欄の id（#backend・#llm・#generation-progress・#budgets・#doctor）は、案内や会話の失敗の知らせからのリンクの行き先
 */
export default function Settings() {
  const { hash, key } = useLocation();
  // リンクで欄へ移ったら、その欄の見出しへフォーカスを移す: 画面は欄まで流れても、フォーカスが本文の頭に残ると、
  // キーボードと読み上げの人は欄まで辿り直すことになるため。key でも走らせる: 同じ欄へのリンクを押し直したときにも移すため
  useEffect(() => {
    if (hash === '') return;
    const target = document
      .getElementById(decodeURIComponent(hash.slice(1)))
      ?.querySelector<HTMLElement>('h2, summary');
    if (target === null || target === undefined) return;
    if (target.tagName === 'H2') target.tabIndex = -1;
    // 流すのは任せる: 欄の id には scroll-mt を付けてあり、フォーカスで流すとその余白が効かないため
    target.focus({ preventScroll: true });
  }, [hash, key]);
  return (
    <Page title="設定">
      <div id="backend" className="scroll-mt-4 space-y-6">
        <BackendStatus />
        <BackendUrlSettings />
      </div>
      <div id="llm" className="scroll-mt-4">
        <LlmSettings />
      </div>
      <div id="generation-progress" className="scroll-mt-4">
        <GenerationProgressSettings />
      </div>
      <BudgetInvalidNotice />
      <Disclosure id="budgets" className="scroll-mt-4" summary="詳しい設定（LLM に渡す量の予算）">
        <BudgetSettings />
      </Disclosure>
      <div id="doctor" className="scroll-mt-4">
        <DoctorCheck />
      </div>
    </Page>
  );
}
