import { Hono } from 'hono';

import type { ApiDeps } from './deps.js';
import { autoJobsRoutes } from './routes/auto-jobs.js';
import { backendRoutes } from './routes/backend.js';
import { filesRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { interventionsRoutes } from './routes/interventions.js';
import { iterationsRoutes } from './routes/iterations.js';
import { jobsRoutes } from './routes/jobs.js';
import { llmSettingsRoutes } from './routes/llm-settings.js';
import { llmCallsRoutes } from './routes/llm-calls.js';
import { manualJobsRoutes } from './routes/manual-jobs.js';
import { selectionsRoutes } from './routes/selections.js';
import { stopConditionsRoutes } from './routes/stop-conditions.js';

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
    .route('/jobs/auto', stopConditionsRoutes(deps))
    .route('/jobs/:jobId/iterations', iterationsRoutes(deps))
    .route('/jobs/:jobId/llm-calls', llmCallsRoutes(deps))
    .route('/jobs', jobsRoutes(deps))
    .route('/jobs', selectionsRoutes(deps))
    .route('/files', filesRoutes(deps))
    .route('/settings/llm', llmSettingsRoutes(deps));
}

export type AppType = ReturnType<typeof createApi>;
