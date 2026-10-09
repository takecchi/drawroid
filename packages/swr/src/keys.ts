// SWR のキー。変更の関数が、関係するキーを mutate で取り直せるように、ここへ集める
export const keys = {
  backend: '/api/backend',
  candidates: (kind: string) => `/api/backend/candidates/${kind}`,
  backendSettings: '/api/settings/backend',
  memory: '/api/memory',
  memoryItem: (id: string) => `/api/memory/${id}`,
  jobs: '/api/jobs',
  job: (jobId: string) => `/api/jobs/${jobId}`,
  iterations: (jobId: string) => `/api/jobs/${jobId}/iterations`,
  selections: (jobId: string) => `/api/jobs/${jobId}/selections`,
  interventions: (jobId: string) => `/api/jobs/auto/${jobId}/interventions`,
  stopConditions: (jobId: string) => `/api/jobs/auto/${jobId}/stop-conditions`,
  llmCalls: (jobId: string) => `/api/jobs/${jobId}/llm-calls`,
  llmCall: (jobId: string, callId: string) => `/api/jobs/${jobId}/llm-calls/${callId}`,
} as const;
