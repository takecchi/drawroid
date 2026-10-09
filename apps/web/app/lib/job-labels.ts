import type { JobSummary } from './job-groups';

export const KIND_LABELS: Record<JobSummary['kind'], string> = {
  manual: '手動',
  auto: '自動',
};

export const STATUS_LABELS: Record<JobSummary['state']['status'], string> = {
  running: '走行中',
  queued: '待ち',
  stopped: '終了',
};

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP');
}
