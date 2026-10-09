import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { invalidConfig, notFound } from '../errors.js';

/** 生成中の途中の画像。設定で有効にしたときだけ、置き場にある1枚を返す */
export function progressPreviewRoutes({
  store,
  progressPreviews,
  generationProgressSettings,
}: ApiDeps) {
  return new Hono().get('/:jobId/progress-preview', async (c) => {
    const { jobId } = c.req.param();
    if (!(await store.listJobIds()).includes(jobId)) return notFound(c, '途中の画像は無い');
    let includePreview: boolean;
    try {
      ({ includePreview } = await generationProgressSettings.read());
    } catch (error) {
      return invalidConfig(c, error instanceof Error ? error.message : String(error));
    }
    const preview = includePreview ? progressPreviews.get(jobId) : undefined;
    if (preview === undefined) return notFound(c, '途中の画像は無い');
    return c.body(preview.data as Uint8Array<ArrayBuffer>, 200, {
      'content-type': preview.mediaType,
      'cache-control': 'no-store',
    });
  });
}
