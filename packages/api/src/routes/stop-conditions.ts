import { readStopConditions } from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { notFound } from '../errors.js';
import { isAutoJob } from './auto-jobs.js';

/** 自動ジョブの止める条件。投入したときの条件と、走行中の変更を重ねた今の条件 */
export function stopConditionsRoutes({ store }: ApiDeps) {
  return new Hono().get('/:jobId/stop-conditions', async (c) => {
    const jobId = c.req.param('jobId');
    if (!(await isAutoJob(store, jobId))) return notFound(c, `自動ジョブ ${jobId} は無い`);
    const spec = await store.readJob(jobId);
    if (spec.kind !== 'auto') return notFound(c, `自動ジョブ ${jobId} は無い`);
    // 投入時の条件も返す: job.json は書き換えないので、画面が「何から変わったか」を出せるように
    return c.json(
      { submitted: spec.stopConditions, current: await readStopConditions(store, spec) },
      200,
    );
  });
}
