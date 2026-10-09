import { Hono } from 'hono';

import type { ApiDeps } from './deps.js';
import { autoJobsRoutes } from './routes/auto-jobs.js';
import { healthRoutes } from './routes/health.js';
import { llmSettingsRoutes } from './routes/llm-settings.js';

export type { ApiDeps, AutoJobQueue, LlmSettingsStore } from './deps.js';

// 機能ごとのルートは routes/ に1ファイルずつ置き、ここには1行ずつ足す
export function createApi(deps: ApiDeps) {
  return new Hono()
    .route('/health', healthRoutes)
    .route('/jobs/auto', autoJobsRoutes(deps))
    .route('/settings/llm', llmSettingsRoutes(deps));
}

export type AppType = ReturnType<typeof createApi>;
