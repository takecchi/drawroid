import { Hono } from 'hono';

import type { ApiDeps } from './deps.js';
import { handleUncaught } from './errors.js';
import { autoJobsRoutes } from './routes/auto-jobs.js';
import { backendRoutes } from './routes/backend.js';
import { backendSettingsRoutes } from './routes/backend-settings.js';
import { filesRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { iterationsRoutes } from './routes/iterations.js';
import { interventionsRoutes } from './routes/interventions.js';
import { jobsRoutes } from './routes/jobs.js';
import { llmSettingsRoutes } from './routes/llm-settings.js';
import { llmCallsRoutes } from './routes/llm-calls.js';
import { manualJobsRoutes } from './routes/manual-jobs.js';
import { memoryRoutes } from './routes/memory.js';
import { stopConditionsRoutes } from './routes/stop-conditions.js';

export {
  BackendBusyError,
  backendKindSchema,
  backendSettingsViewSchema,
  updateBackendSettingsSchema,
  type BackendKind,
  type BackendSettingsPort,
  type BackendSettingsView,
  type UpdateBackendSettings,
} from './backend-settings.js';
export type { ApiDeps, AutoJobQueue, LlmSettingsStore } from './deps.js';
export type { ApiErrorBody } from './errors.js';

// 機能ごとのルートは routes/ に1ファイルずつ置き、ここには1行ずつ足す
export function createApi(deps: ApiDeps) {
  return new Hono()
    .route('/health', healthRoutes)
    .route('/backend', backendRoutes(deps))
    .route('/settings/backend', backendSettingsRoutes(deps))
    .route('/jobs/manual', manualJobsRoutes(deps))
    .route('/jobs/auto', autoJobsRoutes(deps))
    .route('/jobs/:jobId/iterations', iterationsRoutes(deps))
    .route('/jobs/:jobId/llm-calls', llmCallsRoutes(deps))
    .route('/jobs/auto', interventionsRoutes(deps))
    .route('/jobs/auto', stopConditionsRoutes(deps))
    .route('/jobs', jobsRoutes(deps))
    .route('/memory', memoryRoutes(deps))
    .route('/files', filesRoutes(deps))
    .route('/settings/llm', llmSettingsRoutes(deps))
    .onError(handleUncaught);
}

export type AppType = ReturnType<typeof createApi>;
