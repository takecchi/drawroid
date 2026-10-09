import { z } from 'zod';

import { memoryScopeSchema } from '../item.js';

const preferenceSchema = z.object({
  body: z.string(),
  tags: z.array(z.string()),
  scope: memoryScopeSchema,
});

const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), ...preferenceSchema.shape }),
  z.object({ op: z.literal('edit'), id: z.string(), ...preferenceSchema.shape }),
]);

const budgetNoteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clipped'), section: z.string(), from: z.number(), to: z.number() }),
  z.object({ kind: z.literal('dropped'), section: z.string(), reason: z.string() }),
]);

export const distillEntrySchema = z.object({
  /** stopped = ジョブが止まったときの蒸留 / reselection = 止まった後に選択が変わったときの蒸留 */
  kind: z.enum(['stopped', 'reselection']),
  at: z.iso.datetime({ offset: true }),
  /** 対応する LLM 呼び出しの記録（llm-calls/<callId>.json）。呼ぶ前に止めたときは null */
  callId: z.string().nullable(),
  /** 実際に LLM に見せたもの */
  shown: z.object({
    interventions: z.array(z.string()),
    selections: z.array(z.string()),
    memory: z.array(z.string()),
  }),
  /** 予算で切った・落としたもの */
  budgetNotes: z.array(budgetNoteSchema),
  applied: z.array(
    z.discriminatedUnion('op', [
      z.object({ op: z.literal('add'), id: z.string(), after: preferenceSchema }),
      z.object({
        op: z.literal('edit'),
        id: z.string(),
        before: preferenceSchema,
        after: preferenceSchema,
      }),
    ]),
  ),
  /** LLM が出したが、記憶に反映しなかった操作と理由 */
  skipped: z.array(z.object({ operation: operationSchema, reason: z.string() })),
  /** 蒸留そのものができなかったときの理由 */
  failure: z.string().optional(),
});
export type DistillEntry = z.infer<typeof distillEntrySchema>;

/** distill.json の中身。蒸留のたびに1件ずつ追記する */
export const distillFileSchema = z.object({
  jobId: z.string(),
  entries: z.array(distillEntrySchema),
});
export type DistillFile = z.infer<typeof distillFileSchema>;

// 蒸留の記録のポート。置き方（ジョブのディレクトリの distill.json）は実装が決める
export interface DistillLog {
  append(jobId: string, entry: DistillEntry): Promise<void>;
  read(jobId: string): Promise<DistillEntry[]>;
}
