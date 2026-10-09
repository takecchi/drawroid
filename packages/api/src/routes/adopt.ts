import { adoptImage } from '@drawroid/core';
import { Hono } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { conflict, notFound } from '../errors.js';
import { jsonBody } from '../validate.js';

const bodySchema = z.object({
  iteration: z.number().int().positive(),
  index: z.number().int().nonnegative(),
});

/**
 * 画面の「採る」ボタン。人間が選んだ画像をジョブに採らせ、お気に入りにする。会話の adopt_image と同じ口（core の adoptImage）を通る。
 * - 画像が無い・ジョブが無い: 404
 * - ジョブが受け付けない（止まった・手動のジョブ）: 409
 */
export function adoptRoutes({ store, autoQueue, now }: ApiDeps) {
  return new Hono().post('/:jobId/adopt', jsonBody(bodySchema), async (c) => {
    const jobId = c.req.param('jobId');
    // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
    if (!(await store.listJobIds()).includes(jobId)) return notFound(c, `ジョブ ${jobId} は無い`);
    const image = c.req.valid('json');
    const adopt = autoQueue.adopt?.bind(autoQueue);
    if (adopt === undefined)
      return conflict(c, 'unavailable', 'この起動では、画面から画像を採れない');
    const result = await adoptImage(
      { jobs: store, runner: { adopt }, now: now ?? (() => new Date()) },
      jobId,
      image,
    );
    if (result.ok) return c.json({ adopted: image }, 200);
    return result.reason === 'no-image'
      ? notFound(c, result.message)
      : conflict(c, 'conflict', result.message);
  });
}
