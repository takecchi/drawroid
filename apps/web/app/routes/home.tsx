import { useNavigate } from 'react-router';

import { BackendStatus } from '../components/backend-status';
import { ForgeUrlSettings } from '../components/forge-url-settings';
import { GenerationForm } from '../components/generation-form';

export default function Home() {
  const navigate = useNavigate();
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <h1>drawroid</h1>
      <BackendStatus />
      <ForgeUrlSettings />
      <GenerationForm onStarted={(jobId) => void navigate(`/jobs/${jobId}`)} />
    </main>
  );
}
