import type { JobsResponse } from '@drawroid/swr';

export type JobSummary = JobsResponse['jobs'][number];
export type JobStatus = JobSummary['state']['status'];

// 表示順を配列で固定する: 区画の並びを Object.keys の順に任せず、走行中を最上段に置くため
export const JOB_STATUS_ORDER = ['running', 'queued', 'stopped'] as const satisfies JobStatus[];

function compareNewestFirst(a: JobSummary, b: JobSummary): number {
  // 文字列比較にしない: createdAt は offset 付きで、offset が違うと辞書順が時刻の順にならないため
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return byTime !== 0 ? byTime : b.jobId.localeCompare(a.jobId);
}

export function groupJobsByStatus(jobs: readonly JobSummary[]): Record<JobStatus, JobSummary[]> {
  const groups: Record<JobStatus, JobSummary[]> = { running: [], queued: [], stopped: [] };
  for (const job of jobs) groups[job.state.status].push(job);
  for (const status of JOB_STATUS_ORDER) groups[status].sort(compareNewestFirst);
  return groups;
}
