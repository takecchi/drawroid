import { useNavigate } from 'react-router';

import { AutoJobForm } from '../components/auto-job-form';

export default function NewJob() {
  const navigate = useNavigate();
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <h1>依頼</h1>
      <AutoJobForm onCreated={(jobId) => void navigate(`/jobs/${jobId}`)} />
    </main>
  );
}
