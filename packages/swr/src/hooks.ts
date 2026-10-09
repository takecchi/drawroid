import type { CandidateKind } from '@drawroid/core';
import useSWR from 'swr';

import { type ApiError, unwrap } from './api-error.js';
import { client } from './client.js';
import { keys } from './keys.js';
import type {
  BackendSettingsResponse,
  BackendStatus,
  CandidatesResponse,
  InterventionsResponse,
  IterationsResponse,
  JobDetail,
  JobsResponse,
  LlmCallDetail,
  LlmCallsResponse,
  MemoryItemDetail,
  MemoryList,
  SelectionsResponse,
  StopConditionsResponse,
} from './types.js';

const JOBS_POLL_MS = 2000;
const RUNNING_JOB_POLL_MS = 1000;
const JOB_FILES_POLL_MS = 2000;

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

// live を呼び手から受ける: 止まったかどうかは useJob の状態で決まり、このフックは詳細の取得を知らないため
export function useIterations(jobId: string | undefined, { live }: { live: boolean }) {
  return useSWR<IterationsResponse, ApiError>(
    jobId === undefined ? null : keys.iterations(jobId),
    () =>
      unwrap<IterationsResponse>(() =>
        client.jobs[':jobId'].iterations.$get({ param: { jobId: jobId ?? '' } }),
      ),
    { refreshInterval: live ? JOB_FILES_POLL_MS : 0 },
  );
}

export function useInterventions(jobId: string | undefined, { live }: { live: boolean }) {
  return useSWR<InterventionsResponse, ApiError>(
    jobId === undefined ? null : keys.interventions(jobId),
    () =>
      unwrap<InterventionsResponse>(() =>
        client.jobs.auto[':jobId'].interventions.$get({ param: { jobId: jobId ?? '' } }),
      ),
    { refreshInterval: live ? JOB_FILES_POLL_MS : 0 },
  );
}

export function useLlmCalls(jobId: string | undefined, { live }: { live: boolean }) {
  return useSWR<LlmCallsResponse, ApiError>(
    jobId === undefined ? null : keys.llmCalls(jobId),
    () =>
      unwrap<LlmCallsResponse>(() =>
        client.jobs[':jobId']['llm-calls'].$get({ param: { jobId: jobId ?? '' } }),
      ),
    { refreshInterval: live ? JOB_FILES_POLL_MS : 0 },
  );
}

// ポーリングしない: 記録は書かれたら変わらず、開いたときに1度取れば足りるため
export function useLlmCall(jobId: string | undefined, callId: string | undefined) {
  return useSWR<LlmCallDetail, ApiError>(
    jobId === undefined || callId === undefined ? null : keys.llmCall(jobId, callId),
    () =>
      unwrap<LlmCallDetail>(() =>
        client.jobs[':jobId']['llm-calls'][':callId'].$get({
          param: { jobId: jobId ?? '', callId: callId ?? '' },
        }),
      ),
  );
}

export function useBackendSettings() {
  return useSWR<BackendSettingsResponse, ApiError>(keys.backendSettings, () =>
    unwrap<BackendSettingsResponse>(() => client.settings.backend.$get()),
  );
}

export function useMemoryList() {
  return useSWR<MemoryList, ApiError>(keys.memory, () =>
    unwrap<MemoryList>(() => client.memory.$get()),
  );
}

export function useMemoryItem(id: string | undefined) {
  return useSWR<MemoryItemDetail, ApiError>(id === undefined ? null : keys.memoryItem(id), () =>
    unwrap<MemoryItemDetail>(() => client.memory[':id'].$get({ param: { id: id ?? '' } })),
  );
}

// 変更の関数が mutate で取り直すので、ポーリングはしない: 選択を書き換えるのは人間の操作だけのため
export function useSelections(jobId: string | undefined) {
  return useSWR<SelectionsResponse, ApiError>(
    jobId === undefined ? null : keys.selections(jobId),
    () =>
      unwrap<SelectionsResponse>(() =>
        client.jobs[':jobId'].selections.$get({ param: { jobId: jobId ?? '' } }),
      ),
  );
}

// live を呼び手から受ける: 走行中は別の口出し（別タブ・API）でも変わるので取り直し、止まったら変わらないため止める
export function useStopConditions(jobId: string | undefined, { live }: { live: boolean }) {
  return useSWR<StopConditionsResponse, ApiError>(
    jobId === undefined ? null : keys.stopConditions(jobId),
    () =>
      unwrap<StopConditionsResponse>(() =>
        client.jobs.auto[':jobId']['stop-conditions'].$get({ param: { jobId: jobId ?? '' } }),
      ),
    { refreshInterval: live ? JOB_FILES_POLL_MS : 0 },
  );
}
