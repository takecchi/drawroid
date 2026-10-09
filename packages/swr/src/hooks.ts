import type { CandidateKind } from '@drawroid/core';
import useSWR from 'swr';

import { type ApiError, unwrap } from './api-error.js';
import { client } from './client.js';
import { keys } from './keys.js';
import type {
  BackendSettingsResponse,
  BackendStatus,
  CandidatesResponse,
  JobDetail,
  JobsResponse,
} from './types.js';

const JOBS_POLL_MS = 2000;
const RUNNING_JOB_POLL_MS = 1000;

// 失敗の型を ApiError に固定する: 画面が error.kind と error.message を、型の確認なしに読めるようにするため
export function useBackendStatus() {
  return useSWR<BackendStatus, ApiError>(keys.backend, () =>
    unwrap<BackendStatus>(() => client.backend.$get()),
  );
}

export function useCandidates(kind: CandidateKind) {
  return useSWR<CandidatesResponse, ApiError>(keys.candidates(kind), () =>
    unwrap<CandidatesResponse>(() => client.backend.candidates[':kind'].$get({ param: { kind } })),
  );
}

export function useJobs() {
  return useSWR<JobsResponse, ApiError>(
    keys.jobs,
    () => unwrap<JobsResponse>(() => client.jobs.$get()),
    { refreshInterval: JOBS_POLL_MS },
  );
}

// 止まったら取り直さない: 止まったジョブは書き換わらず、ポーリングを続けても同じ応答を取るだけのため
export function useJob(jobId: string | undefined) {
  return useSWR<JobDetail, ApiError>(
    jobId === undefined ? null : keys.job(jobId),
    () => unwrap<JobDetail>(() => client.jobs[':jobId'].$get({ param: { jobId: jobId ?? '' } })),
    {
      refreshInterval: (job) => (job?.state.status === 'stopped' ? 0 : RUNNING_JOB_POLL_MS),
    },
  );
}

export function useBackendSettings() {
  return useSWR<BackendSettingsResponse, ApiError>(keys.backendSettings, () =>
    unwrap<BackendSettingsResponse>(() => client.settings.backend.$get()),
  );
}
