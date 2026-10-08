import { Hono } from 'hono';

import { healthRoutes } from './routes/health.js';

// 機能ごとのルートは routes/ に1ファイルずつ置き、ここには1行ずつ足す
export function createApi() {
  return new Hono().route('/health', healthRoutes);
}

export type AppType = ReturnType<typeof createApi>;
