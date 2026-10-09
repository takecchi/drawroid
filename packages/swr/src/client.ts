import type { AppType } from '@drawroid/api';
import { hc } from 'hono/client';

// 相対パスで作る: 本番は Hono が API と Web UI を同じオリジンで配り、開発では vite の proxy が /api を転送するため
export const client = hc<AppType>('/api');
