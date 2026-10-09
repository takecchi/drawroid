import { useJobs, type JobsResponse } from '@drawroid/swr';
import { Badge, ErrorNote, Item, ItemList, Muted, Section } from '@drawroid/ui';
import { Link } from 'react-router';

import { groupJobsByStatus, JOB_STATUS_ORDER, type JobSummary } from '../lib/job-groups';
import { formatTime, KIND_LABELS, STATUS_LABELS } from '../lib/job-labels';
import { summarizeStopReason } from '../lib/stop-reason';
import { JobStatusBadge } from './job-status-badge';

function JobRow({ job }: { job: JobSummary }) {
  return (
    <Item>
      <Link to={`/jobs/${job.jobId}`} className="underline underline-offset-2">
        <code>{job.jobId}</code>
      </Link>
      <Badge>{KIND_LABELS[job.kind]}</Badge>
      <span className="text-muted-foreground">{formatTime(job.createdAt)}</span>
      <JobStatusBadge status={job.state.status} />
      {job.state.status === 'stopped' && <> ({summarizeStopReason(job.state.reason)})</>}
    </Item>
  );
}

function InvalidJobs({ invalid }: { invalid: JobsResponse['invalid'] }) {
  if (invalid.length === 0) return null;
  return (
    <Section title="読めないジョブ">
      <ItemList>
        {invalid.map(({ jobId, reason }) => (
          <Item key={jobId}>
            <code>{jobId}</code>: {reason}
          </Item>
        ))}
      </ItemList>
    </Section>
  );
}

export function JobList() {
  const { data, error } = useJobs();
  if (data === undefined) {
    return error === undefined ? null : <ErrorNote>一覧を読めない: {error.message}</ErrorNote>;
  }
  const groups = groupJobsByStatus(data.jobs);
  return (
    <>
      {error !== undefined && <ErrorNote>一覧を読めない: {error.message}</ErrorNote>}
      {data.jobs.length === 0 && <Muted>まだ無い。</Muted>}
      {JOB_STATUS_ORDER.map((status) => (
        <Section key={status} title={`${STATUS_LABELS[status]}（${groups[status].length}）`}>
          <ItemList>
            {groups[status].map((job) => (
              <JobRow key={job.jobId} job={job} />
            ))}
          </ItemList>
        </Section>
      ))}
      <InvalidJobs invalid={data.invalid} />
    </>
  );
}
