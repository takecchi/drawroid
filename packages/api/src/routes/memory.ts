import { DEFAULT_DISTILL_BUDGET, memoryScopeSchema, type JobSpec } from '@drawroid/core';
import { Hono } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { conflict, invalidFile, invalidRequest, notFound } from '../errors.js';

// 蒸留の出力と同じ上限を人間の編集にも掛ける: 手で長く書けると、予算で締めた LLM への入力が人間の編集で膨らむため
const limit = DEFAULT_DISTILL_BUDGET.output;

const updateMemorySchema = z.object({
  body: z.string().trim().min(1).max(limit.body),
  tags: z.array(z.string().min(1).max(limit.tag)).max(limit.tags),
  scope: memoryScopeSchema,
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
});

// ストアの assertSafeId と同じ形を、ストアに投げる前に弾く。ストアは安全でない id と読めないファイルを
// どちらも Error で返し、型では見分けられないため、前者を 404 にするにはここで先に判定するしかない
function isSafeId(id: string): boolean {
  return id !== '' && !id.startsWith('.') && !/[/\\\0]/.test(id);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function memoryRoutes({ memoryStore, store }: ApiDeps) {
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

  return new Hono()
    .get('/', async (c) => c.json(await memoryStore.list(), 200))
    .get('/:id', async (c) => {
      const id = c.req.param('id');
      if (!isSafeId(id)) return notFound(c, `記憶 ${id} は無い`);
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
    .put('/:id', async (c) => {
      const id = c.req.param('id');
      if (!isSafeId(id)) return notFound(c, `記憶 ${id} は無い`);
      const parsed = updateMemorySchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return invalidRequest(c, parsed.error.message);
      const { expectedUpdatedAt, ...edit } = parsed.data;

      let current;
      try {
        current = await memoryStore.get(id);
      } catch (error) {
        return invalidFile(c, message(error));
      }
      if (current === null) return notFound(c, `記憶 ${id} は無い`);
      // 画面で開いたあとに変わったものを黙って上書きしない: 人間のファイル編集や蒸留の書き込みを失わないため
      if (current.updatedAt !== expectedUpdatedAt) {
        return conflict(c, 'conflict', '開いたあとに記憶が書き換えられた');
      }
      const item = { ...current, ...edit, updatedAt: new Date().toISOString() };
      await memoryStore.put(item);
      return c.json({ item }, 200);
    })
    .delete('/:id', async (c) => {
      const id = c.req.param('id');
      if (!isSafeId(id)) return notFound(c, `記憶 ${id} は無い`);
      if (!(await memoryStore.remove(id))) return notFound(c, `記憶 ${id} は無い`);
      return c.body(null, 204);
    });
}
