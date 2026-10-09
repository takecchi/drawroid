import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { invalidFile, notFound } from '../errors.js';
import { readAllIterationViews, readIterationView } from '../iterations.js';

export function iterationsRoutes({ store }: ApiDeps) {
  return new Hono()
    .get('/', async (c) => {
      const jobId = c.req.param('jobId') ?? '';
      // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
      if (!(await store.listJobIds()).includes(jobId)) return notFound(c, `ジョブ ${jobId} は無い`);
      return c.json(await readAllIterationViews(store, jobId), 200);
    })
    .get('/:iteration', async (c) => {
      const jobId = c.req.param('jobId') ?? '';
      const raw = c.req.param('iteration');
      if (!(await store.listJobIds()).includes(jobId)) return notFound(c, `ジョブ ${jobId} は無い`);
      const iteration = Number(raw);
      if (!/^[1-9]\d*$/.test(raw) || !(await store.listIterations(jobId)).includes(iteration)) {
        return notFound(c, `回 ${raw} は無い`);
      }
      try {
        return c.json(await readIterationView(store, jobId, iteration), 200);
      } catch (error) {
        return invalidFile(c, error instanceof Error ? error.message : String(error));
      }
    });
}
