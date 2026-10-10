import type { JobStore } from '@drawroid/core';
import { Hono } from 'hono';
import { ZodError } from 'zod';

import type { ApiDeps } from '../deps.js';
import { invalidRequest, notFound } from '../errors.js';

async function isManualJob(store: JobStore, jobId: string): Promise<boolean> {
  // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
  if (!(await store.listJobIds()).includes(jobId)) return false;
  return (await store.readJob(jobId)).kind === 'manual';
}

export function manualJobsRoutes({ manualRunner, store }: ApiDeps) {
  return (
    new Hono()
      .post('/', async (c) => {
        const body: unknown = await c.req.json().catch(() => undefined);
        try {
          const { jobId } = await manualRunner.start(body);
          return c.json({ jobId }, 202);
        } catch (error) {
          if (error instanceof ZodError) return invalidRequest(c, error.message);
          throw error;
        }
      })
      // 自動ジョブの止める口（/jobs/auto/:jobId/stop）と同じ形にする: 画面が同じ扱いで呼べるように
      .post('/:jobId/stop', async (c) => {
        const jobId = c.req.param('jobId');
        if (!(await isManualJob(store, jobId))) return notFound(c, `手動のジョブ ${jobId} は無い`);
        await manualRunner.stop(jobId);
        return c.json({ jobId }, 202);
      })
  );
}
