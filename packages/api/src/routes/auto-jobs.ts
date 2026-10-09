import {
  createCarry,
  hasStopCondition,
  stopConditionsSchema,
  type StopConditions,
} from '@drawroid/core';
import { Hono } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { describeIssues, invalidRequest, notFound } from '../errors.js';

const DEFAULT_STOP_CONDITIONS: StopConditions = { aiJudgement: true, maxIterations: 10 };
const DEFAULT_BATCH_SIZE = 1;

// 止まらないジョブを作らせない: 人間が止めるまで回り続け、GPU と LLM を使い続けるため
const stoppableConditionsSchema = stopConditionsSchema.refine(hasStopCondition, {
  message: '止める条件に、AI の判断か、回数・枚数・時間の上限を1つ以上入れる',
});

const createBodySchema = z.object({
  request: z.string().min(1),
  stopConditions: stoppableConditionsSchema.optional(),
  batchSize: z.number().int().min(1).max(8).optional(),
});

// 一覧と取得は manual と共通の /jobs が持つ。ここには自動ジョブにしか無い口だけを置く
export function autoJobsRoutes(deps: ApiDeps) {
  const { store, autoQueue } = deps;

  async function isAutoJob(jobId: string): Promise<boolean> {
    // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
    if (!(await store.listJobIds()).includes(jobId)) return false;
    return (await store.readJob(jobId)).kind === 'auto';
  }

  return new Hono()
    .post('/', async (c) => {
      const body = createBodySchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return invalidRequest(c, describeIssues(body.error));
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
      autoQueue.kick();
      return c.json({ jobId: spec.jobId }, 202);
    })
    .post('/:jobId/stop', async (c) => {
      const jobId = c.req.param('jobId');
      if (!(await isAutoJob(jobId))) return notFound(c, `自動ジョブ ${jobId} は無い`);
      await autoQueue.stop(jobId);
      return c.json({ jobId }, 202);
    });
}
