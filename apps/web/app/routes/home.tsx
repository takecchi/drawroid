import { useState } from 'react';

import { BackendStatus } from '../components/backend-status';
import { ForgeUrlSettings } from '../components/forge-url-settings';
import { GenerationForm } from '../components/generation-form';
import { JobDetail } from '../components/job-detail';
import { JobList } from '../components/job-list';

export default function Home() {
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>();
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <h1>drawroid</h1>
      <BackendStatus />
      <ForgeUrlSettings />
      <GenerationForm onStarted={setSelectedJobId} />
      <JobList selectedJobId={selectedJobId} onSelect={setSelectedJobId} />
      <JobDetail jobId={selectedJobId} />
    </main>
  );
}
