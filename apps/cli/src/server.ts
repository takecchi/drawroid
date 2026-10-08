import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { createApi } from '@drawroid/api';
import { Hono } from 'hono';

export function createApp({ webRoot }: { webRoot: string }) {
  const app = new Hono();
  app.route('/api', createApi());
  // 未知の /api/* を index.html で返さない: API の誤りが 200 の HTML に化けて、呼び手から見えなくなるため
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  app.use('/*', serveStatic({ root: webRoot }));
  // SPA の経路（/jobs/123 など）はファイルが無いので、index.html を返して画面側の routing に任せる
  app.get('/*', async (c) => c.html(await readFile(join(webRoot, 'index.html'), 'utf8')));
  return app;
}
