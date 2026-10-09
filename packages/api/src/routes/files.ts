import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { notFound } from '../errors.js';

export function filesRoutes({ store, budget }: ApiDeps) {
  return new Hono().get('/jobs/:jobId/iterations/:iteration/images/:file', async (c) => {
    const { jobId, iteration, file } = c.req.param();
    // 外から来た文字列でパスを組まない: 数字と決まった形だけを通し、データディレクトリの他のファイルを返さないため
    const match = /^(\d+)(\.preview\.webp|\.png)$/.exec(file);
    if (
      match === null ||
      !/^[1-9]\d*$/.test(iteration) ||
      !(await store.listJobIds()).includes(jobId)
    ) {
      return notFound(c, 'そのファイルは無い');
    }
    const ref = { jobId, iteration: Number(iteration), index: Number(match[1]) };
    if (match[2] === '.png') {
      const png = await store.readImage(ref);
      if (png === undefined) return notFound(c, 'そのファイルは無い');
      return c.body(png as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'image/png' });
    }
    try {
      const { data } = await store.loadPreview(ref, budget.imageLongEdge);
      return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'image/webp' });
    } catch (error) {
      // 縮小版は原寸から作るので、原寸が無いことは ENOENT で現れる
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return notFound(c, 'そのファイルは無い');
      }
      throw error;
    }
  });
}
