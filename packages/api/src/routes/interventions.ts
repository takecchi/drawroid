import { InterventionRejectedError, stopConditionsChangeSchema } from '@drawroid/core';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { conflict, invalidRequest, notFound } from '../errors.js';
import { referenceUploadSchema } from '../references.js';
import { jsonBody } from '../validate.js';
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
  // 画像を kind と同じ段に並べない: 検証で画像のバイト列に戻すので、判別 union の枝にそのまま置けないため
  z.object({ kind: z.literal('reference'), image: referenceUploadSchema }),
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

/** 走行中・待ち行列の自動ジョブへの口出し（人間の指示・止める条件の変更・参照画像）。どれも次の回の境目から効く */
export function interventionsRoutes({ store, autoQueue }: ApiDeps) {
  return new Hono().post('/:jobId/interventions', jsonBody(bodySchema), async (c) => {
    const jobId = c.req.param('jobId');
    if (!(await isAutoJob(store, jobId))) return notFound(c, `自動ジョブ ${jobId} は無い`);
    const body = c.req.valid('json');
    try {
      if (body.kind === 'instruction') {
        const intervention = await autoQueue.addInstruction(jobId, body.text);
        return c.json({ intervention }, 202);
      }
      if (body.kind === 'reference') {
        const reference = await autoQueue.addReference(jobId, body.image);
        return c.json({ reference }, 202);
      }
      const stopConditions = await autoQueue.changeStopConditions(jobId, body.stopConditions);
      return c.json({ stopConditions }, 202);
    } catch (error) {
      return rejected(c, error);
    }
  });
}
