import { Hono } from 'hono';

import type { ApiDeps } from './deps.js';
import { backendRoutes } from './routes/backend.js';
import { filesRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { jobsRoutes } from './routes/jobs.js';
import { manualJobsRoutes } from './routes/manual-jobs.js';

export type { ApiDeps } from './deps.js';
export type { ApiErrorBody } from './errors.js';

// 機能ごとのルートは routes/ に1ファイルずつ置き、ここには1行ずつ足す
export function createApi(deps: ApiDeps) {
  return new Hono()
    .route('/health', healthRoutes)
    .route('/backend', backendRoutes(deps))
    .route('/jobs/manual', manualJobsRoutes(deps))
    .route('/jobs', jobsRoutes(deps))
    .route('/files', filesRoutes(deps));
}

export type AppType = ReturnType<typeof createApi>;
