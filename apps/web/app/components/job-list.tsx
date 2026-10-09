import { useJobs } from '@drawroid/swr';

export function JobList({
  selectedJobId,
  onSelect,
}: {
  selectedJobId: string | undefined;
  onSelect: (jobId: string) => void;
}) {
  const { data, error } = useJobs();
  return (
    <section>
      <h2>ジョブ</h2>
      {error !== undefined && <p role="alert">一覧を読めない: {error.message}</p>}
      {data?.jobs.length === 0 && <p>まだ無い。</p>}
      <ul>
        {data?.jobs.map((job) => (
          <li key={job.jobId}>
            <button
              type="button"
              onClick={() => onSelect(job.jobId)}
              aria-pressed={job.jobId === selectedJobId}
            >
              <code>{job.jobId}</code>
            </button>{' '}
            {new Date(job.createdAt).toLocaleString('ja-JP')} {job.state.status}
          </li>
        ))}
      </ul>
      {data !== undefined && data.invalid.length > 0 && (
        <>
          <h3>読めないジョブ</h3>
          <ul>
            {data.invalid.map(({ jobId, reason }) => (
              <li key={jobId}>
                <code>{jobId}</code>: {reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
