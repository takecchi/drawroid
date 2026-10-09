import { Page } from '@drawroid/ui';
import { useNavigate } from 'react-router';

import { BackendStatus } from '../components/backend-status';
import { BackendUrlSettings } from '../components/backend-url-settings';
import { BudgetSettings } from '../components/budget-settings';
import { GenerationForm } from '../components/generation-form';
import { LlmSettings } from '../components/llm-settings';

export default function Generate() {
  const navigate = useNavigate();
  return (
    <Page title="生成と設定">
      {/* 案内（SetupNotice）からのリンクの行き先 */}
      <div id="backend" className="scroll-mt-4 space-y-6">
        <BackendStatus />
        <BackendUrlSettings />
      </div>
      <div id="llm" className="scroll-mt-4">
        <LlmSettings />
      </div>
      <BudgetSettings />
      <GenerationForm onStarted={(jobId) => void navigate(`/jobs/${jobId}`)} />
    </Page>
  );
}
