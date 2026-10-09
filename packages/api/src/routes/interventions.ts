import { InterventionRejectedError, stopConditionsChangeSchema } from '@drawroid/core';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { conflict, describeIssues, invalidRequest, notFound } from '../errors.js';
import { isAutoJob } from './auto-jobs.js';

// 原文はそのまま interventions/ に残るので、1件の長さに上限を置く。LLM に載せる量は別に planInterventions が締める
const MAX_INSTRUCTION_CHARS = 2000;

const bodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('instruction'),
    text: z
      .string()
      .max(MAX_INSTRUCTION_CHARS)
      .refine((text) => text.trim().length > 0, { message: '指示が空' }),
  }),
  z.object({ kind: z.literal('stopConditions'), stopConditions: stopConditionsChangeSchema }),
]);

function rejected(c: Context, error: unknown) {
  if (!(error instanceof InterventionRejectedError)) throw error;
  switch (error.reason) {
    case 'unstoppable':
      return invalidRequest(c, error.message);
    case 'stopped':
      return conflict(c, error.message);
    case 'manual':
      return notFound(c, error.message);
  }
}

/** 走行中・待ち行列の自動ジョブへの口出し（人間の指示・止める条件の変更）。どれも次の回の境目から効く */
export function interventionsRoutes({ store, autoQueue }: ApiDeps) {
  return new Hono().post('/:jobId/interventions', async (c) => {
    const jobId = c.req.param('jobId');
    if (!(await isAutoJob(store, jobId))) return notFound(c, `自動ジョブ ${jobId} は無い`);
    const body = bodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return invalidRequest(c, describeIssues(body.error));
    try {
      if (body.data.kind === 'instruction') {
        const intervention = await autoQueue.addInstruction(jobId, body.data.text);
        return c.json({ intervention }, 202);
      }
      const stopConditions = await autoQueue.changeStopConditions(jobId, body.data.stopConditions);
      return c.json({ stopConditions }, 202);
    } catch (error) {
      return rejected(c, error);
    }
  });
}
