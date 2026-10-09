// SWR のキー。変更の関数が、関係するキーを mutate で取り直せるように、ここへ集める
export const keys = {
  backend: '/api/backend',
  candidates: (kind: string) => `/api/backend/candidates/${kind}`,
  candidateNotes: '/api/backend/candidate-notes',
  backendSettings: '/api/settings/backend',
  memory: '/api/memory',
  memoryItem: (id: string) => `/api/memory/${id}`,
  llmSettings: '/api/settings/llm',
  permissionSettings: '/api/settings/permissions',
  budgetSettings: '/api/settings/budgets',
  generationProgressSettings: '/api/settings/generation-progress',
  jobs: '/api/jobs',
  job: (jobId: string) => `/api/jobs/${jobId}`,
  jobDistill: (jobId: string) => `/api/jobs/${jobId}/distill`,
  /** 選び直したあと、覚えたことの記録が増えるのを待つ印（取りに行かない、画面の中だけのキー） */
  jobDistillWait: (jobId: string) => `local:job-distill-wait/${jobId}`,
  iterations: (jobId: string) => `/api/jobs/${jobId}/iterations`,
  selections: (jobId: string) => `/api/jobs/${jobId}/selections`,
  interventions: (jobId: string) => `/api/jobs/auto/${jobId}/interventions`,
  references: (jobId: string) => `/api/jobs/auto/${jobId}/references`,
  stopConditions: (jobId: string) => `/api/jobs/auto/${jobId}/stop-conditions`,
  llmCalls: (jobId: string) => `/api/jobs/${jobId}/llm-calls`,
  llmCall: (jobId: string, callId: string) => `/api/jobs/${jobId}/llm-calls/${callId}`,
  /** ジョブに属さない LLM 呼び出し（止める条件の変換など） */
  unattachedLlmCalls: '/api/llm-calls',
  unattachedLlmCall: (callId: string) => `/api/llm-calls/${callId}`,
  conversations: '/api/conversations',
  conversationEvents: (conversationId: string, after: number) =>
    `/api/conversations/${conversationId}/events?after=${after}`,
} as const;
