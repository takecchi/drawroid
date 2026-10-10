import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { createApi, type ApiDeps } from '@drawroid/api';
import { Hono } from 'hono';

/** この端末を指す名前。ポートは問わない（開発中は Vite が localhost:5173 の Host のまま中継する） */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** 何も書き換えない要求 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Origin がこの端末のページか。`null`（サンドボックスの iframe・file:）や読めない値は、この端末のものとしない */
function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_NAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function createApp({ webRoot, deps }: { webRoot: string; deps: ApiDeps }) {
  const app = new Hono();
  // この端末の名前以外の Host は断る: DNS rebinding で別のサイトの名前を 127.0.0.1 へ向け直されると、そのサイトの画面が
  // 同じオリジンとして API を読み書きできる（LLM の設定の宛先を差し替えて、鍵をそこへ送らせる、など）ため
  app.use('*', async (c, next) => {
    if (!LOOPBACK_NAMES.has(new URL(c.req.url).hostname)) {
      return c.json(
        {
          error: {
            kind: 'forbidden_host',
            message: 'drawroid は、この端末の名前（127.0.0.1・localhost）で開いたときだけ応える',
          },
        },
        403,
      );
    }
    await next();
  });
  // 別のサイトのページから来た書き込みは断る: プリフライトの要らない単純な要求（text/plain の POST など）は、どのサイトの
  // ページからでも送れ、本文を JSON として読む口では、生成や LLM の呼び出しが始まってしまうため。
  // Origin の無い要求（curl・台本）は通す。読むだけの要求は、CORS を許していないので別のサイトからは中身が読めない
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (!SAFE_METHODS.has(c.req.method) && origin !== undefined && !isLoopbackOrigin(origin)) {
      return c.json(
        {
          error: {
            kind: 'forbidden_origin',
            message: 'drawroid は、ほかのサイトのページから送られた変更を受けない',
          },
        },
        403,
      );
    }
    await next();
  });
  app.route('/api', createApi(deps));
  // 未知の /api/* を index.html で返さない: API の誤りが 200 の HTML に化けて、呼び手から見えなくなるため
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  app.use('/*', serveStatic({ root: webRoot }));
  // SPA の経路（/jobs/123 など）はファイルが無いので、index.html を返して画面側の routing に任せる
  app.get('/*', async (c) => c.html(await readFile(join(webRoot, 'index.html'), 'utf8')));
  return app;
}
