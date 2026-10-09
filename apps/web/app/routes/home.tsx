import { Page } from '@drawroid/ui';
import { useNavigate } from 'react-router';

import { BackendStatus } from '../components/backend-status';
import { BackendUrlSettings } from '../components/backend-url-settings';
import { GenerationForm } from '../components/generation-form';
import { LlmSettings } from '../components/llm-settings';

export default function Home() {
  const navigate = useNavigate();
  return (
    <Page title="drawroid">
      <BackendStatus />
      <BackendUrlSettings />
      <LlmSettings />
      <GenerationForm onStarted={(jobId) => void navigate(`/jobs/${jobId}`)} />
    </Page>
  );
}
