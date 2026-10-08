import { z } from 'zod';

export const stopConditionsSchema = z.object({
  /** 見る役が「意図どおり」と判断したら止める */
  aiJudgement: z.boolean(),
  maxIterations: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxImages: z.number().int().positive().optional(),
});
export type StopConditions = z.infer<typeof stopConditionsSchema>;

const jobIdentity = {
  jobId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
};

/**
 * job.json の中身。ジョブを作ったときに決まり、止める条件の変更のほかは書き換えない。
 * manual は M1 の単発生成（回が1つの手動ジョブ）、auto は M2 のループ。
 */
export const jobSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), ...jobIdentity }),
  z.object({
    kind: z.literal('auto'),
    ...jobIdentity,
    request: z.string().min(1),
    stopConditions: stopConditionsSchema,
    /** 1回の生成で出す枚数 */
    batchSize: z.number().int().positive(),
  }),
]);
export type JobSpec = z.infer<typeof jobSpecSchema>;
export type AutoJobSpec = Extract<JobSpec, { kind: 'auto' }>;
/** createJob に渡す形（jobId と createdAt は置き場所が決める） */
export type NewJobSpec = JobSpec extends infer S
  ? S extends JobSpec
    ? Omit<S, 'jobId' | 'createdAt'>
    : never
  : never;

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
});
export type StopReason = z.infer<typeof stopReasonSchema>;

const thinkParamsSchema = z.object({
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  seed: z.number().optional(),
  steps: z.number().optional(),
  cfg: z.number().optional(),
});

const carriedResultSchema = z.object({
  iteration: z.number().int().positive(),
  imageIndex: z.number().int().nonnegative(),
  score: z.number(),
  params: thinkParamsSchema,
  issues: z.array(z.string()),
  nextChange: z.string(),
});

export const carrySchema = z.object({
  intent: z.string(),
  completedIterations: z.number().int().nonnegative(),
  best: carriedResultSchema.optional(),
  latest: carriedResultSchema.optional(),
});

/**
 * state.json の中身。どの段まで済んだかは持たない（段の出力ファイルの有無が正）。
 */
// 段の進み具合をここに写さない: 出力ファイルと二重に持つと、落ちたときにずれるため
export const jobStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('queued'), carry: carrySchema }),
  z.object({
    status: z.literal('running'),
    carry: carrySchema,
    startedAt: z.iso.datetime({ offset: true }),
    imagesGenerated: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('stopped'),
    carry: carrySchema,
    startedAt: z.iso.datetime({ offset: true }).optional(),
    stoppedAt: z.iso.datetime({ offset: true }),
    imagesGenerated: z.number().int().nonnegative(),
    reason: stopReasonSchema,
  }),
]);
export type JobState = z.infer<typeof jobStateSchema>;
