import { DEFAULT_BUDGETS, UnreadableImageError, type JobStore } from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { invalidFile, notFound } from '../errors.js';

// 設定の今の値を使わない: 縮小版の名前は長辺を含み、ジョブの途中で変わると同じ画像の縮小版が2つできて、画面と記録で指す縮小版が食い違うため
async function previewLongEdge(store: JobStore, jobId: string): Promise<number> {
  const spec = await store.readJob(jobId);
  return (
    (spec.kind === 'auto' ? spec.budgets?.imageLongEdge : undefined) ??
    DEFAULT_BUDGETS.imageLongEdge
  );
}

export function filesRoutes({ store }: ApiDeps) {
  return new Hono()
    .get('/jobs/:jobId/refs/:file', async (c) => {
      const { jobId, file } = c.req.param();
      // 一覧に在る参照画像だけを通す: 外から来た refId でパスを組まず、データディレクトリの他のファイルを返さないため
      const match = /^(.+)\.preview\.webp$/.exec(file);
      if (match === null || !(await store.listJobIds()).includes(jobId)) {
        return notFound(c, 'そのファイルは無い');
      }
      const refId = match[1];
      if (!(await store.listReferences(jobId)).some((r) => r.refId === refId)) {
        return notFound(c, 'そのファイルは無い');
      }
      try {
        const { data } = await store.loadPreview(
          { jobId, refId: refId ?? '' },
          await previewLongEdge(store, jobId),
        );
        return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'image/webp' });
      } catch (error) {
        if (error instanceof UnreadableImageError) return invalidFile(c, error.message);
        throw error;
      }
    })
    .get('/jobs/:jobId/iterations/:iteration/images/:file', async (c) => {
      const { jobId, iteration, file } = c.req.param();
      // 外から来た文字列でパスを組まない: 数字と決まった形だけを通し、データディレクトリの他のファイルを返さないため
      const match = /^(\d+)(\.preview\.webp|\.png)$/.exec(file);
      if (
        match === null ||
        !/^[1-9]\d*$/.test(iteration) ||
        !(await store.listJobIds()).includes(jobId)
      ) {
        return notFound(c, 'そのファイルは無い');
      }
      const ref = { jobId, iteration: Number(iteration), index: Number(match[1]) };
      if (match[2] === '.png') {
        const png = await store.readImage(ref);
        if (png === undefined) return notFound(c, 'そのファイルは無い');
        return c.body(png as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'image/png' });
      }
      try {
        const { data } = await store.loadPreview(ref, await previewLongEdge(store, jobId));
        return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'image/webp' });
      } catch (error) {
        // 縮小版は原寸から作るので、原寸が無いことは ENOENT で現れる
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return notFound(c, 'そのファイルは無い');
        }
        if (error instanceof UnreadableImageError) return invalidFile(c, error.message);
        throw error;
      }
    });
}
