import { Hono } from 'hono';

import type { ApiDeps } from './deps.js';
import { autoJobsRoutes } from './routes/auto-jobs.js';
import { backendRoutes } from './routes/backend.js';
import { filesRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { interventionsRoutes } from './routes/interventions.js';
import { jobsRoutes } from './routes/jobs.js';
import { llmSettingsRoutes } from './routes/llm-settings.js';
import { manualJobsRoutes } from './routes/manual-jobs.js';

export type { ApiDeps, AutoJobQueue, LlmSettingsStore } from './deps.js';
export type { ApiErrorBody } from './errors.js';

// 機能ごとのルートは routes/ に1ファイルずつ置き、ここには1行ずつ足す
export function createApi(deps: ApiDeps) {
  return new Hono()
    .route('/health', healthRoutes)
    .route('/backend', backendRoutes(deps))
    .route('/jobs/manual', manualJobsRoutes(deps))
    .route('/jobs/auto', autoJobsRoutes(deps))
    .route('/jobs/auto', interventionsRoutes(deps))
    .route('/jobs', jobsRoutes(deps))
    .route('/files', filesRoutes(deps))
    .route('/settings/llm', llmSettingsRoutes(deps));
}

export type AppType = ReturnType<typeof createApi>;
