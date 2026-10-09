import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { notFound } from '../errors.js';

export function filesRoutes({ store }: ApiDeps) {
  return new Hono().get('/jobs/:jobId/iterations/:iteration/images/:file', async (c) => {
    const { jobId, iteration, file } = c.req.param();
    // 外から来た文字列でパスを組まない: 数字と決まった形だけを通し、データディレクトリの他のファイルを返さないため
    const index = /^(\d+)\.png$/.exec(file)?.[1];
    if (
      index === undefined ||
      !/^[1-9]\d*$/.test(iteration) ||
      !(await store.listJobIds()).includes(jobId)
    ) {
      return notFound(c, 'そのファイルは無い');
    }
    const png = await store.readImage({
      jobId,
      iteration: Number(iteration),
      index: Number(index),
    });
    if (png === undefined) return notFound(c, 'そのファイルは無い');
    return c.body(png as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'image/png' });
  });
}
