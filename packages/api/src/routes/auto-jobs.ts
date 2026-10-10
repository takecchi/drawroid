import {
  batchSizeProblem,
  createCarry,
  hasAnyStopCondition,
  permissionOverridesSchema,
  stopConditionsSchema,
  type JobStore,
  type StopConditions,
} from '@drawroid/core';
import { Hono } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { invalidRequest, notFound } from '../errors.js';
import { imageProblem } from '../images.js';
import { referenceUploadsSchema } from '../references.js';
import { jsonBody } from '../validate.js';

const DEFAULT_STOP_CONDITIONS: StopConditions = { aiJudgement: true, maxIterations: 10 };
const DEFAULT_BATCH_SIZE = 1;

// 止まらないジョブを作らせない: 人間が止めるまで回り続け、GPU と LLM を使い続けるため
const stoppableConditionsSchema = stopConditionsSchema.refine(hasAnyStopCondition, {
  message: '止める条件に、AI の判断か、回数・枚数・時間の上限を1つ以上入れる',
});

const createBodySchema = z.object({
  request: z.string().min(1),
  stopConditions: stoppableConditionsSchema.optional(),
  batchSize: z.number().int().min(1).max(8).optional(),
  /** 依頼に添える参照画像。最初の回の境目で、見る役が1度だけ見て要点にする */
  references: referenceUploadsSchema.optional(),
  // このジョブだけの許可の上書き。書いたパラメータだけを、全体の既定に重ねる
  permissions: permissionOverridesSchema.optional(),
});

export async function isAutoJob(store: JobStore, jobId: string): Promise<boolean> {
  // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
  if (!(await store.listJobIds()).includes(jobId)) return false;
  return (await store.readJob(jobId)).kind === 'auto';
}

// 一覧と取得は manual と共通の /jobs が持つ。ここには自動ジョブにしか無い口だけを置く
export function autoJobsRoutes(deps: ApiDeps) {
  const { store, autoQueue } = deps;

  return (
    new Hono()
      // validator を通す: 送る本文の型（参照画像は base64 のまま）を、画面の側が hono/client から引けるようにするため
      .post('/', jsonBody(createBodySchema), async (c) => {
        const { request, stopConditions, batchSize, references, permissions } = c.req.valid('json');
        // ジョブを作る前に全部読む: 1枚でも読めなければ、何も保存せずジョブも始めないため
        for (const [i, reference] of (references ?? []).entries()) {
          const problem = await imageProblem(reference.data, reference.mediaType);
          if (problem !== undefined) return invalidRequest(c, `references.${i}.data: ${problem}`);
        }
        const now = (deps.now ?? (() => new Date()))();
        // 投入のときに1度だけ読み、ジョブへ写す: 以後に設定を変えても、走っている・待っているジョブの上限は変えないため
        const { effective } = await deps.budgetSettings.read();
        const tooMany = batchSizeProblem(batchSize ?? DEFAULT_BATCH_SIZE, effective);
        if (tooMany !== undefined) return invalidRequest(c, tooMany);
        const spec = await store.createJob(
          {
            kind: 'auto',
            request,
            stopConditions: stopConditions ?? DEFAULT_STOP_CONDITIONS,
            batchSize: batchSize ?? DEFAULT_BATCH_SIZE,
            ...(permissions !== undefined && { permissions }),
            budgets: effective,
          },
          { status: 'queued', carry: createCarry(request, effective).carry },
          now,
          // ジョブを作ってから足さない: ランナーが先にジョブを拾うと、最初の回の「考える」に要点が載らないため
          references ?? [],
        );
        autoQueue.kick();
        return c.json({ jobId: spec.jobId }, 202);
      })
      .post('/:jobId/stop', async (c) => {
        const jobId = c.req.param('jobId');
        if (!(await isAutoJob(store, jobId))) return notFound(c, `自動ジョブ ${jobId} は無い`);
        await autoQueue.stop(jobId);
        return c.json({ jobId }, 202);
      })
  );
}
