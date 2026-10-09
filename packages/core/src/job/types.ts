import { z } from 'zod';

import { generationRequestSchema } from '../backend.js';
import { BACKEND_ERROR_KINDS } from '../backend-error.js';

export const stopConditionsSchema = z.object({
  /** 見る役が「意図どおり」と判断したら止める */
  aiJudgement: z.boolean(),
  maxIterations: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxImages: z.number().int().positive().optional(),
});
export type StopConditions = z.infer<typeof stopConditionsSchema>;

const jobSpecBase = {
  jobId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
};

/** 人間がパラメータを明示して1回だけ生成するジョブ。パース済みの要求をそのまま保存する */
export const manualJobSpecSchema = z.object({
  ...jobSpecBase,
  kind: z.literal('manual'),
  request: generationRequestSchema,
});
export type ManualJobSpec = z.infer<typeof manualJobSpecSchema>;

export const autoJobSpecSchema = z.object({
  ...jobSpecBase,
  kind: z.literal('auto'),
  request: z.string().min(1),
  stopConditions: stopConditionsSchema,
  /** 1回の生成で出す枚数 */
  batchSize: z.number().int().positive(),
});
export type AutoJobSpec = z.infer<typeof autoJobSpecSchema>;

/** job.json の中身。ジョブを作ったときに決まり、止める条件の変更のほかは書き換えない */
export const jobSpecSchema = z.discriminatedUnion('kind', [manualJobSpecSchema, autoJobSpecSchema]);
export type JobSpec = z.infer<typeof jobSpecSchema>;

export const STOP_REASON_KINDS = [
  'ai',
  'limit:iterations',
  'limit:duration',
  'limit:images',
  'human',
  'error',
] as const;

export const stopReasonSchema = z.object({
  kind: z.enum(STOP_REASON_KINDS),
  /** 人間が読む短い説明。error ではどの段で何が起きたか */
  detail: z.string(),
  // バックエンドの失敗のときだけ付く。画面が「落ちている」のか「URL が違う」のかを見分けるため
  backendErrorKind: z.enum(BACKEND_ERROR_KINDS).optional(),
});
export type StopReason = z.infer<typeof stopReasonSchema>;

/**
 * state.json の中身。どの段まで済んだかは持たない（段の出力ファイルの有無が正）。
 */
// 段の進み具合をここに写さない: 出力ファイルと二重に持つと、落ちたときにずれるため
export const jobStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('queued') }),
  z.object({
    status: z.literal('running'),
    startedAt: z.iso.datetime({ offset: true }),
    imagesGenerated: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('stopped'),
    startedAt: z.iso.datetime({ offset: true }).optional(),
    stoppedAt: z.iso.datetime({ offset: true }),
    imagesGenerated: z.number().int().nonnegative(),
    reason: stopReasonSchema,
  }),
]);
export type JobState = z.infer<typeof jobStateSchema>;
