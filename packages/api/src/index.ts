import { Hono } from 'hono';

import type { ApiDeps } from './deps.js';
import { handleUncaught } from './errors.js';
import { autoJobsRoutes } from './routes/auto-jobs.js';
import { backendRoutes } from './routes/backend.js';
import { candidateNotesRoutes } from './routes/candidate-notes.js';
import { filesRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { interventionsRoutes } from './routes/interventions.js';
import { jobsRoutes } from './routes/jobs.js';
import { llmSettingsRoutes } from './routes/llm-settings.js';
import { manualJobsRoutes } from './routes/manual-jobs.js';
import { permissionSettingsRoutes } from './routes/permission-settings.js';
import { stopConditionsRoutes } from './routes/stop-conditions.js';

export type {
  ApiDeps,
  AutoJobQueue,
  CandidateNotesStore,
  LlmSettingsStore,
  PermissionSettingsStore,
} from './deps.js';
export type { ApiErrorBody } from './errors.js';

// 機能ごとのルートは routes/ に1ファイルずつ置き、ここには1行ずつ足す
export function createApi(deps: ApiDeps) {
  return new Hono()
    .route('/health', healthRoutes)
    .route('/backend', backendRoutes(deps))
    .route('/backend', candidateNotesRoutes(deps))
    .route('/jobs/manual', manualJobsRoutes(deps))
    .route('/jobs/auto', autoJobsRoutes(deps))
    .route('/jobs/auto', interventionsRoutes(deps))
    .route('/jobs/auto', stopConditionsRoutes(deps))
    .route('/jobs', jobsRoutes(deps))
    .route('/files', filesRoutes(deps))
    .route('/settings/llm', llmSettingsRoutes(deps))
    .route('/settings/permissions', permissionSettingsRoutes(deps))
    .onError(handleUncaught);
}

export type AppType = ReturnType<typeof createApi>;
