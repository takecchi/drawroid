// SWR のキー。変更の関数が、関係するキーを mutate で取り直せるように、ここへ集める
export const keys = {
  backend: '/api/backend',
  candidates: (kind: string) => `/api/backend/candidates/${kind}`,
  backendSettings: '/api/settings/backend',
  jobs: '/api/jobs',
  job: (jobId: string) => `/api/jobs/${jobId}`,
} as const;
