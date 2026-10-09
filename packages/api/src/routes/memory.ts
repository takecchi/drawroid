import { isMemoryId, memoryScopeSchema, type DistillBudget, type JobSpec } from '@drawroid/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono/validator';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { conflict, invalidFile, invalidRequest, notFound } from '../errors.js';

// 蒸留の出力と同じ上限を人間の編集にも掛ける: 手で長く書けると、予算で締めた LLM への入力が人間の編集で膨らむため。
// 上限は設定で変わるので、要求のたびに読んで組み立てる
const updateMemorySchema = (limit: DistillBudget['output']) =>
  z.object({
    body: z.string().trim().min(1).max(limit.body),
    tags: z.array(z.string().min(1).max(limit.tag)).max(limit.tags),
    scope: memoryScopeSchema,
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
  });

// ストアに投げる前に、ストアと同じ isMemoryId で弾く。ストアは使えない形の id と読めないファイルを
// どちらも Error で返し、型では見分けられないため、前者を 404 にするにはここで先に判定するしかない

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function memoryRoutes({ memoryStore, store, budgetSettings }: ApiDeps) {
  async function describeSource(jobId: string, knownJobIds: ReadonlySet<string>) {
    // 一覧に在るものだけを引く: front matter は人間が書き換えられ、そのまま置き場所へ渡さないため
    if (!knownJobIds.has(jobId)) return { jobId, job: null };
    try {
      const spec: JobSpec = await store.readJob(jobId);
      const request = spec.kind === 'auto' ? spec.request : spec.request.prompt;
      return { jobId, job: { kind: spec.kind, createdAt: spec.createdAt, request } };
    } catch {
      // 読めないジョブで項目の表示を止めない: 学んだ元が壊れていても、記憶そのものは見て直せるべきため
      return { jobId, job: null };
    }
  }

  return (
    new Hono()
      // validator は JSON として読めない body を HTTPException で投げ、他のルートと違う形の応答になる。エラーの体を揃えるためここで受ける
      .onError((error, c) => {
        if (!(error instanceof HTTPException)) throw error;
        return error.status === 400 ? invalidRequest(c, error.message) : error.getResponse();
      })
      .get('/', async (c) => c.json(await memoryStore.list(), 200))
      .get('/:id', async (c) => {
        const id = c.req.param('id');
        if (!isMemoryId(id)) return notFound(c, `記憶 ${id} は無い`);
        let item;
        try {
          item = await memoryStore.get(id);
        } catch (error) {
          return invalidFile(c, message(error));
        }
        if (item === null) return notFound(c, `記憶 ${id} は無い`);
        const knownJobIds = new Set(await store.listJobIds());
        const sources = await Promise.all(
          item.sources.map((jobId) => describeSource(jobId, knownJobIds)),
        );
        return c.json({ item, sources }, 200);
      })
      // hono/validator を通す: c.req.json() を直に読むと、hono/client が body の型を導けず、画面側に手で型を書くことになるため
      .put(
        '/:id',
        validator('json', async (value, c) => {
          const { effective } = await budgetSettings.read();
          const parsed = updateMemorySchema(effective.distill.output).safeParse(value);
          return parsed.success ? parsed.data : invalidRequest(c, parsed.error.message);
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!isMemoryId(id)) return notFound(c, `記憶 ${id} は無い`);
          const { expectedUpdatedAt, ...edit } = c.req.valid('json');

          // 比べることと書くことを、ストアの update の中で1つの手順にする: 比べてから書くまでのあいだに
          // 蒸留などが書くと、その内容を黙って上書きするため（Issue #44）
          let read = false;
          let outcome;
          try {
            outcome = await memoryStore.update(id, (current) => {
              read = true;
              // 画面で開いたあとに変わったものを黙って上書きしない: 人間のファイル編集や蒸留の書き込みを失わないため
              if (current === null || current.updatedAt !== expectedUpdatedAt) return undefined;
              return { ...current, ...edit, updatedAt: new Date().toISOString() };
            });
          } catch (error) {
            // 読めないファイルだけを invalid_file にする。書くときの失敗は、ほかのルートと同じく投げる
            if (!read) return invalidFile(c, message(error));
            throw error;
          }
          if (outcome.before === null) return notFound(c, `記憶 ${id} は無い`);
          if (outcome.written === undefined) {
            return conflict(c, 'conflict', '開いたあとに記憶が書き換えられた');
          }
          return c.json({ item: outcome.written }, 200);
        },
      )
      .delete('/:id', async (c) => {
        const id = c.req.param('id');
        if (!isMemoryId(id)) return notFound(c, `記憶 ${id} は無い`);
        if (!(await memoryStore.remove(id))) return notFound(c, `記憶 ${id} は無い`);
        return c.body(null, 204);
      })
  );
}
