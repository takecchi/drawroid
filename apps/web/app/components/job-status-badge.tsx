import { Badge, type BadgeTone } from '@drawroid/ui';

import { STATUS_LABELS } from '../lib/job-labels';
import type { JobSummary } from '../lib/job-groups';

type Status = JobSummary['state']['status'];

const STATUS_TONES: Record<Status, BadgeTone> = {
  running: 'ok',
  queued: 'warn',
  stopped: 'muted',
};

export function JobStatusBadge({ status }: { status: Status }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}
