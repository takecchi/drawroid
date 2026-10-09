import { createCarry, stopConditionsSchema, type StopConditions } from '@drawroid/core';
import { Hono } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { describeIssues, errorBody } from '../errors.js';

const DEFAULT_STOP_CONDITIONS: StopConditions = { aiJudgement: true, maxIterations: 10 };
const DEFAULT_BATCH_SIZE = 1;

const createBodySchema = z.object({
  request: z.string().min(1),
  stopConditions: stopConditionsSchema.optional(),
  batchSize: z.number().int().min(1).max(8).optional(),
});

export function autoJobsRoutes(deps: ApiDeps) {
  const { store, queue } = deps;

  async function findAuto(jobId: string) {
    // 一覧に在るかで確かめる: ".." などのパスを store に渡さないため
    if (!(await store.listJobIds()).includes(jobId)) return undefined;
    const spec = await store.readJob(jobId);
    return spec.kind === 'auto' ? spec : undefined;
  }
  const notFound = (jobId: string) => errorBody('not_found', `自動ジョブ ${jobId} が無い`);

  return new Hono()
    .post('/', async (c) => {
      const body = createBodySchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success)
        return c.json(errorBody('invalid_request', describeIssues(body.error)), 400);
      const { request, stopConditions, batchSize } = body.data;
      const spec = await store.createJob(
        {
          kind: 'auto',
          request,
          stopConditions: stopConditions ?? DEFAULT_STOP_CONDITIONS,
          batchSize: batchSize ?? DEFAULT_BATCH_SIZE,
        },
        { status: 'queued', carry: createCarry(request, deps.budget).carry },
        (deps.now ?? (() => new Date()))(),
      );
      queue.kick();
      return c.json({ jobId: spec.jobId }, 202);
    })
    .get('/', async (c) => {
      const jobs = [];
      for (const jobId of await store.listJobIds()) {
        const spec = await store.readJob(jobId);
        if (spec.kind === 'auto') jobs.push({ spec, state: await store.readState(jobId) });
      }
      return c.json({ jobs });
    })
    .get('/:jobId', async (c) => {
      const jobId = c.req.param('jobId');
      const spec = await findAuto(jobId);
      if (spec === undefined) return c.json(notFound(jobId), 404);
      return c.json({ spec, state: await store.readState(jobId) }, 200);
    })
    .post('/:jobId/stop', async (c) => {
      const jobId = c.req.param('jobId');
      if ((await findAuto(jobId)) === undefined) return c.json(notFound(jobId), 404);
      await queue.stop(jobId);
      return c.json({ jobId }, 202);
    });
}
