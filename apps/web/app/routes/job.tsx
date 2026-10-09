import { Page } from '@drawroid/ui';

import { JobDetail } from '../components/job-detail';
import type { Route } from './+types/job';

export default function Job({ params }: Route.ComponentProps) {
  return (
    <Page>
      <JobDetail jobId={params.jobId} />
    </Page>
  );
}
