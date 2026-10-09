import { z } from 'zod';

export const stopConditionsSchema = z.object({
  /** 見る役が「意図どおり」と判断したら止める */
  aiJudgement: z.boolean(),
  maxIterations: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxImages: z.number().int().positive().optional(),
});
export type StopConditions = z.infer<typeof stopConditionsSchema>;

const limitChange = z.number().int().positive().nullable().optional();

/** 走行中の止める条件の変更。書いた欄だけを変え、上限の欄の null はその上限を外す */
export const stopConditionsChangeSchema = z
  .object({
    aiJudgement: z.boolean().optional(),
    maxIterations: limitChange,
    maxDurationMs: limitChange,
    maxImages: limitChange,
  })
  .strict()
  .refine((change) => Object.keys(change).length > 0, { message: '変える欄が無い' });
export type StopConditionsChange = z.infer<typeof stopConditionsChangeSchema>;

const interventionIdentity = {
  interventionId: z.string().min(1),
  receivedAt: z.iso.datetime({ offset: true }),
};

/**
 * interventions/<interventionId>.json の中身。人間の口出し1件。
 * instruction は「考える」に取り込む人間の指示で、原文は書き換えず、取り込んだ回だけを書き戻す。
 * stopConditions は止める条件の変更で、LLM を通さず回の境目で job.json の条件に重ねる。
 */
// 止める条件の変更を job.json に書き込まない: job.json は依頼の原文の記録で、実際の条件と二重に持つことになるため（Issue #5 の E）
export const interventionRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('instruction'),
    ...interventionIdentity,
    text: z.string().min(1),
    /** 「考える」に取り込んだ回。未反映の間は無い */
    appliedInIteration: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('stopConditions'),
    ...interventionIdentity,
    stopConditions: stopConditionsChangeSchema,
  }),
]);
export type InterventionRecord = z.infer<typeof interventionRecordSchema>;
export type InstructionIntervention = Extract<InterventionRecord, { kind: 'instruction' }>;
export type StopConditionsIntervention = Extract<InterventionRecord, { kind: 'stopConditions' }>;
/** addIntervention に渡す形（interventionId と receivedAt は置き場所が決め、受けたときは未反映） */
export type NewIntervention =
  | { kind: 'instruction'; text: string }
  | { kind: 'stopConditions'; stopConditions: StopConditionsChange };

const jobIdentity = {
  jobId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
};

/**
 * job.json の中身。ジョブを作ったときに決まり、書き換えない。
 * 走行中の止める条件の変更は interventions/ に置き、回の境目でここの止める条件に重ねる。
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
