import { describe, expect, it } from 'vitest';

import { groupJobsByStatus, type JobSummary } from './job-groups';

function job(jobId: string, createdAt: string, state: JobSummary['state']): JobSummary {
  return { jobId, kind: 'manual', createdAt, state };
}

const stopped = {
  status: 'stopped',
  stoppedAt: '2026-10-09T00:00:00Z',
  imagesGenerated: 1,
  reason: { kind: 'human', detail: '' },
} as const;

describe('groupJobsByStatus', () => {
  it('splits jobs into running, queued and stopped sections', () => {
    const groups = groupJobsByStatus([
      job('a', '2026-10-09T00:00:00Z', { status: 'queued' }),
      job('b', '2026-10-09T00:00:00Z', stopped),
      job('c', '2026-10-09T00:00:00Z', {
        status: 'running',
        startedAt: '2026-10-09T00:00:00Z',
        imagesGenerated: 0,
      }),
    ]);
    expect(groups.running.map((j) => j.jobId)).toEqual(['c']);
    expect(groups.queued.map((j) => j.jobId)).toEqual(['a']);
    expect(groups.stopped.map((j) => j.jobId)).toEqual(['b']);
  });

  it('orders each section newest first', () => {
    const groups = groupJobsByStatus([
      job('old', '2026-10-08T00:00:00Z', stopped),
      job('new', '2026-10-09T00:00:00Z', stopped),
      job('mid', '2026-10-08T12:00:00Z', stopped),
    ]);
    expect(groups.stopped.map((j) => j.jobId)).toEqual(['new', 'mid', 'old']);
  });

  it('compares instants rather than text when offsets differ', () => {
    const groups = groupJobsByStatus([
      job('later-utc', '2026-10-09T01:00:00Z', stopped),
      job('earlier-utc', '2026-10-09T09:00:00+09:00', stopped),
    ]);
    expect(groups.stopped.map((j) => j.jobId)).toEqual(['later-utc', 'earlier-utc']);
  });

  it('returns empty sections for no jobs', () => {
    expect(groupJobsByStatus([])).toEqual({ running: [], queued: [], stopped: [] });
  });

  it('orders jobs created at the same instant by jobId, later id first', () => {
    const groups = groupJobsByStatus([
      job('a', '2026-10-09T00:00:00Z', stopped),
      job('c', '2026-10-09T00:00:00Z', stopped),
      job('b', '2026-10-09T00:00:00Z', stopped),
    ]);
    expect(groups.stopped.map((j) => j.jobId)).toEqual(['c', 'b', 'a']);
  });

  it('does not reorder the input', () => {
    const input = [
      job('a', '2026-10-08T00:00:00Z', stopped),
      job('b', '2026-10-09T00:00:00Z', stopped),
    ];
    groupJobsByStatus(input);
    expect(input.map((j) => j.jobId)).toEqual(['a', 'b']);
  });
});
