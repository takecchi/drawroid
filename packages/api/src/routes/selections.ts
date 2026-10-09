import {
  ImageNotFoundError,
  parseImageKey,
  selectImage,
  selectionVerdictSchema,
  summarizeSelections,
} from '@drawroid/core';
import { Hono } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { invalidRequest, notFound } from '../errors.js';
import { jsonBody } from '../validate.js';

const bodySchema = z.object({
  /** null は選択を外す */
  verdict: selectionVerdictSchema.nullable(),
});

/** 回の画像への人間の最終選択（お気に入り・却下）。手動のジョブ・自動のジョブのどちらにも付けられる */
export function selectionsRoutes({ store, now, reselection }: ApiDeps) {
  async function hasJob(jobId: string): Promise<boolean> {
    // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
    return (await store.listJobIds()).includes(jobId);
  }

  return new Hono()
    .get('/:jobId/selections', async (c) => {
      const jobId = c.req.param('jobId');
      if (!(await hasJob(jobId))) return notFound(c, `ジョブ ${jobId} は無い`);
      return c.json({ selections: await summarizeSelections(store, jobId) }, 200);
    })
    .put('/:jobId/selections/:imageKey', jsonBody(bodySchema), async (c) => {
      const jobId = c.req.param('jobId');
      const imageKey = c.req.param('imageKey');
      if (!(await hasJob(jobId))) return notFound(c, `ジョブ ${jobId} は無い`);
      if (parseImageKey(imageKey) === undefined) {
        return invalidRequest(c, `画像キーは <回>-<画像> の形で書く: ${imageKey}`);
      }
      try {
        const selection = await selectImage({
          store,
          jobId,
          imageKey,
          verdict: c.req.valid('json').verdict,
          now: (now ?? (() => new Date()))(),
        });
        // 蒸留を待たない: LLM を待つ間、選択の操作の応答が止まるため
        reselection?.notify(jobId);
        return c.json({ selection }, 200);
      } catch (error) {
        if (error instanceof ImageNotFoundError) return notFound(c, error.message);
        throw error;
      }
    });
}
