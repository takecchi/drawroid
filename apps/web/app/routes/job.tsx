import { JobDetail } from '../components/job-detail';
import type { Route } from './+types/job';

export default function Job({ params }: Route.ComponentProps) {
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <JobDetail jobId={params.jobId} />
    </main>
  );
}
