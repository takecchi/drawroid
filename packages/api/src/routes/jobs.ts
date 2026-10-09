import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { notFound } from '../errors.js';
import { readAllIterationViews, summarizeAdopted, summarizeJudge } from '../iterations.js';

export function jobsRoutes({ store }: ApiDeps) {
  return new Hono()
    .get('/', async (c) => {
      const jobs = [];
      const invalid: { jobId: string; reason: string }[] = [];
      // 新しい順: 画面は直近のジョブを上に出す
      for (const jobId of (await store.listJobIds()).reverse()) {
        try {
          const [spec, state] = await Promise.all([store.readJob(jobId), store.readState(jobId)]);
          jobs.push({ jobId, kind: spec.kind, createdAt: spec.createdAt, state });
        } catch (error) {
          // 一覧ごと失敗させない: 人間が手で触って壊した1件のために、ほかのジョブまで見えなくなるため
          invalid.push({ jobId, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return c.json({ jobs, invalid }, 200);
    })
    .get('/:jobId', async (c) => {
      const jobId = c.req.param('jobId');
      // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
      if (!(await store.listJobIds()).includes(jobId)) {
        return notFound(c, `ジョブ ${jobId} は無い`);
      }
      const [spec, state, read] = await Promise.all([
        store.readJob(jobId),
        store.readState(jobId),
        // listGenerations で一括しない: 壊れた回が1つあると詳細ごと失敗するため
        readAllIterationViews(store, jobId),
      ]);
      const iterations = read.iterations.map(({ iteration, request, judge, adopted, images }) => ({
        iteration,
        request,
        images,
        judge: summarizeJudge(judge) ?? summarizeAdopted(adopted, iteration, images.length),
      }));
      return c.json({ spec, state, iterations, invalid: read.invalid }, 200);
    });
}
