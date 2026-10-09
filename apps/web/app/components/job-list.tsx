import { useJobs, type JobsResponse } from '@drawroid/swr';
import { Link } from 'react-router';

import { groupJobsByStatus, JOB_STATUS_ORDER, type JobSummary } from '../lib/job-groups';
import { formatTime, KIND_LABELS, STATUS_LABELS } from '../lib/job-labels';
import { summarizeStopReason } from '../lib/stop-reason';

function JobRow({ job }: { job: JobSummary }) {
  return (
    <li>
      <Link to={`/jobs/${job.jobId}`}>
        <code>{job.jobId}</code>
      </Link>{' '}
      {KIND_LABELS[job.kind]} {formatTime(job.createdAt)} {STATUS_LABELS[job.state.status]}
      {job.state.status === 'stopped' && <> ({summarizeStopReason(job.state.reason)})</>}
    </li>
  );
}

function InvalidJobs({ invalid }: { invalid: JobsResponse['invalid'] }) {
  if (invalid.length === 0) return null;
  return (
    <section>
      <h2>読めないジョブ</h2>
      <ul>
        {invalid.map(({ jobId, reason }) => (
          <li key={jobId}>
            <code>{jobId}</code>: {reason}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function JobList() {
  const { data, error } = useJobs();
  if (data === undefined) {
    return error === undefined ? null : <p role="alert">一覧を読めない: {error.message}</p>;
  }
  const groups = groupJobsByStatus(data.jobs);
  return (
    <>
      {error !== undefined && <p role="alert">一覧を読めない: {error.message}</p>}
      {data.jobs.length === 0 && <p>まだ無い。</p>}
      {JOB_STATUS_ORDER.map((status) => (
        <section key={status}>
          <h2>
            {STATUS_LABELS[status]}（{groups[status].length}）
          </h2>
          <ul>
            {groups[status].map((job) => (
              <JobRow key={job.jobId} job={job} />
            ))}
          </ul>
        </section>
      ))}
      <InvalidJobs invalid={data.invalid} />
    </>
  );
}
