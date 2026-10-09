import type { CandidateKind } from '@drawroid/core';
import useSWR from 'swr';

import { type ApiError, unwrap } from './api-error.js';
import { client } from './client.js';
import { keys } from './keys.js';
import type {
  BackendSettingsResponse,
  BackendStatus,
  BudgetSettingsResponse,
  CandidateNotesResponse,
  CandidatesResponse,
  ConversationEventsResponse,
  ConversationsResponse,
  InterventionsResponse,
  IterationsResponse,
  JobDetail,
  JobsResponse,
  LlmCallDetail,
  LlmCallsResponse,
  LlmSettingsResponse,
  PermissionSettingsResponse,
  MemoryItemDetail,
  MemoryList,
  ReferencesResponse,
  SelectionsResponse,
  UnattachedLlmCallsResponse,
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

// ポーリングしない: 説明を変えるのは人間の操作だけで、保存の関数が置き直すため
export function useCandidateNotes() {
  return useSWR<CandidateNotesResponse, ApiError>(keys.candidateNotes, () =>
    unwrap<CandidateNotesResponse>(() => client.backend['candidate-notes'].$get()),
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

// 走っている間は取り直す: 見る役が要点を作ると、要点と渡した印が後から付くため
export function useReferences(jobId: string | undefined, { live }: { live: boolean }) {
  return useSWR<ReferencesResponse, ApiError>(
    jobId === undefined ? null : keys.references(jobId),
    () =>
      unwrap<ReferencesResponse>(() =>
        client.jobs.auto[':jobId'].references.$get({ param: { jobId: jobId ?? '' } }),
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

/**
 * LLM 呼び出し1件の記録。jobId が null なら、ジョブに属さない呼び出し（止める条件の変換など）を読む。
 */
// ポーリングしない: 記録は書かれたら変わらず、開いたときに1度取れば足りるため
export function useLlmCall(jobId: string | null | undefined, callId: string | undefined) {
  const key =
    jobId === undefined || callId === undefined
      ? null
      : jobId === null
        ? keys.unattachedLlmCall(callId)
        : keys.llmCall(jobId, callId);
  return useSWR<LlmCallDetail, ApiError>(key, () =>
    unwrap<LlmCallDetail>(() =>
      jobId === null
        ? client['llm-calls'][':callId'].$get({ param: { callId: callId ?? '' } })
        : client.jobs[':jobId']['llm-calls'][':callId'].$get({
            param: { jobId: jobId ?? '', callId: callId ?? '' },
          }),
    ),
  );
}

/** ジョブに属さない LLM 呼び出しの一覧。止める条件を変換するたびに増えるので、開いている間は取り直す */
export function useUnattachedLlmCalls() {
  return useSWR<UnattachedLlmCallsResponse, ApiError>(
    keys.unattachedLlmCalls,
    () => unwrap<UnattachedLlmCallsResponse>(() => client['llm-calls'].$get()),
    { refreshInterval: JOB_FILES_POLL_MS },
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

// ポーリングしない: 設定を変えるのは人間の操作だけで、保存の関数が mutate で取り直すため
// 一覧は数秒おきに読み直す: 走っているかの印が、別のタブや会話の画面の操作で変わるため
export function useConversations() {
  return useSWR<ConversationsResponse, ApiError>(
    keys.conversations,
    () => unwrap<ConversationsResponse>(() => client.conversations.$get()),
    { refreshInterval: JOBS_POLL_MS },
  );
}

/** 確定したイベントの1ページ。続きは会話の画面が SSE で受ける */
export function useConversationEvents(conversationId: string | undefined, after = 0) {
  return useSWR<ConversationEventsResponse, ApiError>(
    conversationId === undefined ? null : keys.conversationEvents(conversationId, after),
    () =>
      unwrap<ConversationEventsResponse>(() =>
        client.conversations[':conversationId'].events.$get({
          param: { conversationId: conversationId ?? '' },
          query: { after: String(after) },
        }),
      ),
  );
}

export function useLlmSettings() {
  return useSWR<LlmSettingsResponse, ApiError>(keys.llmSettings, () =>
    unwrap<LlmSettingsResponse>(() => client.settings.llm.$get()),
  );
}

// 変更の関数が mutate で取り直すので、ポーリングはしない: 選択を書き換えるのは人間の操作だけのため
// ポーリングしない: 許可を変えるのは人間の操作だけで、保存の関数が置き直すため
export function usePermissionSettings() {
  return useSWR<PermissionSettingsResponse, ApiError>(keys.permissionSettings, () =>
    unwrap<PermissionSettingsResponse>(() => client.settings.permissions.$get()),
  );
}

// ポーリングしない: 予算を変えるのは人間の操作だけで、保存の関数が置き直すため
export function useBudgetSettings() {
  return useSWR<BudgetSettingsResponse, ApiError>(keys.budgetSettings, () =>
    unwrap<BudgetSettingsResponse>(() => client.settings.budgets.$get()),
  );
}

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
