import type { DistillEntry } from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { invalidFile, notFound } from '../errors.js';

/**
 * ジョブから覚えたこと（ジョブのディレクトリの distill.json）。止まりのカードの「このジョブから覚えたこと」が読む。
 * 返すのは画面に要る欄だけ: 蒸留の種類・時刻・足した項目（ID と本文）・直した項目（ID と前後の本文）・失敗の理由。
 * LLM に見せたもの・予算の記録・反映しなかった操作・呼び出しの ID は返さない（記録はジョブの LLM の記録で読める）
 */
export function distillRoutes({ store, distillLog }: ApiDeps) {
  return new Hono().get('/:jobId/distill', async (c) => {
    const jobId = c.req.param('jobId');
    // 一覧に在るものだけを通す: 外から来た文字列をそのまま置き場所へ渡さないため
    if (!(await store.listJobIds()).includes(jobId)) return notFound(c, `ジョブ ${jobId} は無い`);
    let entries: DistillEntry[];
    try {
      entries = (await distillLog?.read(jobId)) ?? [];
    } catch (error) {
      return invalidFile(c, error instanceof Error ? error.message : String(error));
    }
    return c.json({ entries: entries.map(toView) }, 200);
  });
}

function toView(entry: DistillEntry) {
  return {
    kind: entry.kind,
    at: entry.at,
    added: entry.applied.flatMap((op) =>
      op.op === 'add' ? [{ id: op.id, body: op.after.body }] : [],
    ),
    edited: entry.applied.flatMap((op) =>
      op.op === 'edit' ? [{ id: op.id, before: op.before.body, after: op.after.body }] : [],
    ),
    ...(entry.failure !== undefined && { failure: entry.failure }),
  };
}
