import { Hono } from 'hono';

import type { ApiDeps } from './deps.js';
import { backendRoutes } from './routes/backend.js';
import { backendSettingsRoutes } from './routes/backend-settings.js';
import { filesRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { jobsRoutes } from './routes/jobs.js';
import { manualJobsRoutes } from './routes/manual-jobs.js';
import { memoryRoutes } from './routes/memory.js';

export {
  BackendBusyError,
  backendSettingsViewSchema,
  updateBackendSettingsSchema,
  type BackendSettingsPort,
  type BackendSettingsView,
  type UpdateBackendSettings,
} from './backend-settings.js';
export type { ApiDeps } from './deps.js';
export type { ApiErrorBody } from './errors.js';

// 機能ごとのルートは routes/ に1ファイルずつ置き、ここには1行ずつ足す
export function createApi(deps: ApiDeps) {
  return new Hono()
    .route('/health', healthRoutes)
    .route('/backend', backendRoutes(deps))
    .route('/settings/backend', backendSettingsRoutes(deps))
    .route('/jobs/manual', manualJobsRoutes(deps))
    .route('/jobs', jobsRoutes(deps))
    .route('/memory', memoryRoutes(deps))
    .route('/files', filesRoutes(deps));
}

export type AppType = ReturnType<typeof createApi>;
