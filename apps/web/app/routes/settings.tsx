import { Disclosure, Page } from '@drawroid/ui';

import { BackendStatus } from '../components/backend-status';
import { BackendUrlSettings } from '../components/backend-url-settings';
import { BudgetSettings } from '../components/budget-settings';
import { LlmSettings } from '../components/llm-settings';

/**
 * 設定。初めての人が要るもの（画像のバックエンドと LLM）を上に置き、予算は「詳しい設定」として畳む。
 * 欄の id（#backend・#llm・#budgets）は、案内や会話の失敗の知らせからのリンクの行き先
 */
export default function Settings() {
  return (
    <Page title="設定">
      <div id="backend" className="scroll-mt-4 space-y-6">
        <BackendStatus />
        <BackendUrlSettings />
      </div>
      <div id="llm" className="scroll-mt-4">
        <LlmSettings />
      </div>
      <Disclosure id="budgets" className="scroll-mt-4" summary="詳しい設定（LLM に渡す量の予算）">
        <BudgetSettings />
      </Disclosure>
    </Page>
  );
}
