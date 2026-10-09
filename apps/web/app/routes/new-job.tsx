import { Page } from '@drawroid/ui';
import { useNavigate } from 'react-router';

import { AutoJobForm } from '../components/auto-job-form';

export default function NewJob() {
  const navigate = useNavigate();
  return (
    <Page title="依頼">
      <AutoJobForm onCreated={(jobId) => void navigate(`/jobs/${jobId}`)} />
    </Page>
  );
}
