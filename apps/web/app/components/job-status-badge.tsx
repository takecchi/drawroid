import { StatusBadge, type StatusMap } from '@drawroid/ui';

import { STATUS_LABELS } from '../lib/job-labels';
import type { JobSummary } from '../lib/job-groups';

type Status = JobSummary['state']['status'];

const STATUS_VIEWS: StatusMap<Status> = {
  running: { tone: 'ok', label: STATUS_LABELS.running },
  queued: { tone: 'warn', label: STATUS_LABELS.queued },
  stopped: { tone: 'muted', label: STATUS_LABELS.stopped },
};

export function JobStatusBadge({ status }: { status: Status }) {
  return <StatusBadge status={status} map={STATUS_VIEWS} />;
}
