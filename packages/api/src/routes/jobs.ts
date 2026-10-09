import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { notFound } from '../errors.js';

export function jobsRoutes({ store }: ApiDeps) {
  return new Hono()
    .get('/', async (c) => {
      const jobs = [];
      // 新しい順: 画面は直近のジョブを上に出す
      for (const jobId of (await store.listJobIds()).reverse()) {
        const [spec, state] = await Promise.all([store.readJob(jobId), store.readState(jobId)]);
        jobs.push({ jobId, kind: spec.kind, createdAt: spec.createdAt, state });
      }
      return c.json({ jobs }, 200);
    })
    .get('/:jobId', async (c) => {
      const jobId = c.req.param('jobId');
      // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
      if (!(await store.listJobIds()).includes(jobId)) {
        return notFound(c, `ジョブ ${jobId} は無い`);
      }
      const [spec, state, generations] = await Promise.all([
        store.readJob(jobId),
        store.readState(jobId),
        store.listGenerations(jobId),
      ]);
      const iterations = generations.map(({ iteration, request, images }) => ({
        iteration,
        request,
        images: images.map(({ index, seed }) => ({
          index,
          seed,
          url: `/api/files/jobs/${jobId}/iterations/${iteration}/images/${index}.png`,
        })),
      }));
      return c.json({ spec, state, iterations }, 200);
    });
}
