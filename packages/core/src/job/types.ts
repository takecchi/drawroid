import { z } from 'zod';

import { generationRequestSchema } from '../backend.js';
import { BACKEND_ERROR_KINDS } from '../backend-error.js';
import { storedBudgetsSchema } from '../budget/settings.js';
import { permissionOverridesSchema } from '../permissions/permission.js';

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
  // mask は inpaint のマスク。画像そのものは masks/<interventionId>.png で、塗った生成画像に紐づく（Issue #5 の H）
  z.object({
    kind: z.literal('mask'),
    ...interventionIdentity,
    image: z.object({
      iteration: z.number().int().positive(),
      index: z.number().int().nonnegative(),
    }),
    /** inpaint に使った回。1回使うと切れる。使われる前に新しいマスクが来ても切れる */
    usedInIteration: z.number().int().positive().optional(),
  }),
  // adopt は人間がその回の画像を「これでいい」と選んだ印。取り込んだかは、その回の adopted.json の有無で決まる
  z.object({
    kind: z.literal('adopt'),
    ...interventionIdentity,
    image: z.object({
      iteration: z.number().int().positive(),
      index: z.number().int().nonnegative(),
    }),
  }),
]);
export type InterventionRecord = z.infer<typeof interventionRecordSchema>;
export type MaskIntervention = Extract<InterventionRecord, { kind: 'mask' }>;
/** addMask に渡す形。data は PNG（白い所を描き直す） */
export type NewMask = { image: { iteration: number; index: number }; data: Uint8Array };
export type AdoptIntervention = Extract<InterventionRecord, { kind: 'adopt' }>;
export type InstructionIntervention = Extract<InterventionRecord, { kind: 'instruction' }>;
export type StopConditionsIntervention = Extract<InterventionRecord, { kind: 'stopConditions' }>;
/** addIntervention に渡す形（interventionId と receivedAt は置き場所が決め、受けたときは未反映） */
export type NewIntervention =
  | { kind: 'instruction'; text: string }
  | { kind: 'stopConditions'; stopConditions: StopConditionsChange }
  | { kind: 'adopt'; image: { iteration: number; index: number } };

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
  /** 全体の既定の許可に重ねる、このジョブだけの上書き。書いたパラメータだけ */
  permissions: permissionOverridesSchema.optional(),
  /** 投入のときに解決した予算。走行中は読み直さない。無い古いジョブは runner の既定で回る */
  budgets: storedBudgetsSchema.optional(),
  /** このジョブを作った会話。今の投入画面と API で作ったジョブには無い */
  conversationId: z.string().min(1).optional(),
  /** このジョブを作った、会話のターンの番号 */
  turn: z.number().int().positive().optional(),
});
export type AutoJobSpec = z.infer<typeof autoJobSpecSchema>;

/**
 * job.json の中身。ジョブを作ったときに決まり、書き換えない。
 * 走行中の止める条件の変更は interventions/ に置き、回の境目でここの止める条件に重ねる。
 */
export const jobSpecSchema = z.discriminatedUnion('kind', [manualJobSpecSchema, autoJobSpecSchema]);
export type JobSpec = z.infer<typeof jobSpecSchema>;

export const STOP_REASON_KINDS = [
  'ai',
  'limit:iterations',
  'limit:duration',
  'limit:images',
  'human',
  /** 人間が画像を選び、続く指示が無かった */
  'adopted',
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
 * iterations/<n>/adopted.json の中身。その回の評価を「人間が選んだ」で打ち切った記録で、judge.json の代わりに置く。
 * 置いたことが、その回の見る段が済んだことを表す。
 */
export const adoptedRecordSchema = z.object({
  by: z.literal('human'),
  image: z.object({
    iteration: z.number().int().positive(),
    index: z.number().int().nonnegative(),
  }),
  /** 人間が選んだ画像は、見る役の評価を経ずに満点として扱う */
  score: z.literal(1),
  interventionId: z.string().min(1),
  adoptedAt: z.iso.datetime({ offset: true }),
});
export type AdoptedRecord = z.infer<typeof adoptedRecordSchema>;

// 欄を閉じない: M4 で考える役が決めてよいパラメータが許可の設定しだいで増え、閉じると読み直しで黙って消えるため
const thinkParamsSchema = z.looseObject({
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  seed: z.number().optional(),
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
});

const carriedResultSchema = z.object({
  iteration: z.number().int().positive(),
  imageIndex: z.number().int().nonnegative(),
  score: z.number(),
  params: thinkParamsSchema,
  issues: z.array(z.string()),
  nextChange: z.string(),
});

/** 自動ジョブが回をまたいで持ち回す状態の要約 */
export const carrySchema = z.object({
  intent: z.string(),
  completedIterations: z.number().int().nonnegative(),
  best: carriedResultSchema.optional(),
  latest: carriedResultSchema.optional(),
  references: z.array(z.object({ refId: z.string().min(1), gist: z.string() })).optional(),
});

export const REFERENCE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * refs/<refId>.json の中身。人間が添えた参照画像1枚の、用途の言葉・要点・渡した印。画像そのものは refs/<refId>.<ext>。
 */
export const referenceRecordSchema = z.object({
  refId: z.string().min(1),
  receivedAt: z.iso.datetime({ offset: true }),
  mediaType: z.enum(REFERENCE_MEDIA_TYPES),
  /** 人間が添えた用途の言葉（「この構図で」など） */
  note: z.string().min(1).optional(),
  /** 見る役が1度だけ見て書いた要点。以後はこれだけを持ち回す */
  gist: z.string().optional(),
  /** 画像を LLM に渡した呼び出しの ID（渡した印） */
  sentInCall: z.string().min(1).optional(),
  sentAt: z.iso.datetime({ offset: true }).optional(),
});
export type ReferenceRecord = z.infer<typeof referenceRecordSchema>;
export type NewReference = {
  data: Uint8Array;
  mediaType: ReferenceRecord['mediaType'];
  note?: string;
};

// carry は auto のジョブだけが持つ。manual は回が1つで、持ち回すものが無い
const carryField = { carry: carrySchema.optional() };

/**
 * state.json の中身。どの段まで済んだかは持たない（段の出力ファイルの有無が正）。
 */
// 段の進み具合をここに写さない: 出力ファイルと二重に持つと、落ちたときにずれるため
export const jobStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('queued'), ...carryField }),
  z.object({
    status: z.literal('running'),
    ...carryField,
    startedAt: z.iso.datetime({ offset: true }),
    imagesGenerated: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('stopped'),
    ...carryField,
    startedAt: z.iso.datetime({ offset: true }).optional(),
    stoppedAt: z.iso.datetime({ offset: true }),
    imagesGenerated: z.number().int().nonnegative(),
    reason: stopReasonSchema,
  }),
]);
export type JobState = z.infer<typeof jobStateSchema>;
