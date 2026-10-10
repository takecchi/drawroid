import { z } from 'zod';

import { stopConditionsSchema, stopReasonSchema } from '../job/types.js';
import { permissionOverridesSchema } from '../permissions/permission.js';
import { iterationPlanSchema } from '../think/excluded.js';

// 会話のイベント（設計: docs/design/conversational-agent.md の「イベント」）。
// 確定するもの（ConversationEvent）は events/<seq>.json に1件1ファイルで置き、画面の表示・復帰・話す役への入力の正本にする。
// 確定しないもの（LiveEvent）はファイルに書かず、ハブがメモリの写しから流すだけにする

/** 話す役のターンの番号（会話の中で 1 から） */
const turnSchema = z.number().int().positive();
/** 確定しない増分と、それが確定したイベントを結ぶ ID。画面は同じ partId の増分を、確定の本文で置き換える */
const partIdSchema = z.string().min(1);
const iterationSchema = z.number().int().positive();

const userMessage = z.object({
  type: z.literal('user.message'),
  text: z.string(),
  /** 会話で添えた画像（uploads/ の ID） */
  attachments: z.array(z.object({ uploadId: z.string().min(1) })).default([]),
  /** 二重送信を見分ける、画面が付けた ID。同じ ID の再送は二重に受けない */
  clientMessageId: z.string().min(1).optional(),
});

const turnStarted = z.object({
  type: z.literal('turn.started'),
  turn: turnSchema,
  /** このターンでまとめて読んだ人間の発言の seq */
  messageSeqs: z.array(z.number().int().positive()),
  /** 会話のジョブが止まったことを受けて起こしたターンなら、そのジョブ。同じジョブで2度は起こさない */
  jobId: z.string().min(1).optional(),
});

const assistantReasoning = z.object({
  type: z.literal('assistant.reasoning'),
  turn: turnSchema,
  partId: partIdSchema,
  /** モデルが自分で出した思考（ステップごとに確定したもの）。次の入力には戻さない */
  text: z.string(),
});

const assistantMessage = z.object({
  type: z.literal('assistant.message'),
  turn: turnSchema,
  partId: partIdSchema,
  text: z.string(),
  /** 人間の割り込みなどで、流れている途中で打ち切られたか */
  interrupted: z.boolean().default(false),
});

const toolCall = z.object({
  type: z.literal('tool.call'),
  turn: turnSchema,
  callId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

const toolResult = z.object({
  type: z.literal('tool.result'),
  turn: turnSchema,
  callId: z.string().min(1),
  ok: z.boolean(),
  /** 表示用の結果の要約 */
  summary: z.string(),
});

export const TURN_OUTCOMES = ['done', 'interrupted', 'error'] as const;

const turnEnded = z.object({
  type: z.literal('turn.ended'),
  turn: turnSchema,
  outcome: z.enum(TURN_OUTCOMES),
  reason: z.string().optional(),
});

const jobStarted = z.object({
  type: z.literal('job.started'),
  jobId: z.string().min(1),
  /** 依頼の要点 */
  request: z.string(),
  stopConditions: stopConditionsSchema,
  /** このジョブだけの許可の上書き（書いた欄だけ） */
  permissions: permissionOverridesSchema.optional(),
});

const jobThink = z.object({
  type: z.literal('job.think'),
  jobId: z.string().min(1),
  iteration: iterationSchema,
  /** 考える役が自分で出した思考（あれば） */
  reasoning: z.string().optional(),
  /** 決定の短い理由 */
  rationale: z.string(),
  /** 考える役が決めたパラメータの要約（欄 → 値） */
  params: z.record(z.string(), z.unknown()),
  /** その回に AI の選択肢から外したもの（plan.json） */
  excluded: iterationPlanSchema.shape.excluded.default([]),
});

const jobImages = z.object({
  type: z.literal('job.images'),
  jobId: z.string().min(1),
  iteration: iterationSchema,
  /** 画像の参照。中身はジョブのファイルが正で、会話には写さない */
  images: z.array(
    z.object({ index: z.number().int().nonnegative(), seed: z.number().int().nullable() }),
  ),
  /**
   * 頼んだ画像の大きさ（px）。画面は縦横の比として使い、読み込む前から画像の背を取る（hires で拡大しても比は変わらない）。
   * 読み込んでから背が伸びると、上の画像が遅れて読み込まれたとき、読んでいる行が押し下げられるため。古い記録には無い
   */
  size: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
});

const jobJudge = z.object({
  type: z.literal('job.judge'),
  jobId: z.string().min(1),
  iteration: iterationSchema,
  images: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      score: z.number(),
      issues: z.array(z.string()),
    }),
  ),
  nextChange: z.string(),
  canStop: z.boolean(),
  /** 見る役が自分で出した思考（あれば） */
  reasoning: z.string().optional(),
});

const jobAdopted = z.object({
  type: z.literal('job.adopted'),
  jobId: z.string().min(1),
  iteration: iterationSchema,
  /** 人間が選んだ画像。見る役を呼ばずに、この回の評価を打ち切った（adopted.json） */
  image: z.object({ iteration: iterationSchema, index: z.number().int().nonnegative() }),
});

const jobIntervention = z.object({
  type: z.literal('job.intervention'),
  jobId: z.string().min(1),
  interventionId: z.string().min(1),
  /** 口出しの種類（instruction・stopConditions・reference・mask など） */
  kind: z.string().min(1),
  /** 取り込んだ回 */
  iteration: iterationSchema,
});

const jobStopped = z.object({
  type: z.literal('job.stopped'),
  jobId: z.string().min(1),
  reason: stopReasonSchema,
});

/** 書く前のイベント（seq と時刻は置き場所が決める） */
export const newConversationEventSchema = z.discriminatedUnion('type', [
  userMessage,
  turnStarted,
  assistantReasoning,
  assistantMessage,
  toolCall,
  toolResult,
  turnEnded,
  jobStarted,
  jobThink,
  jobImages,
  jobJudge,
  jobAdopted,
  jobIntervention,
  jobStopped,
]);
export type NewConversationEvent = z.input<typeof newConversationEventSchema>;

const confirmed = {
  /** 会話の中で起きた順の番号（1 から、欠けなし）。SSE の id: と Last-Event-ID に使う */
  seq: z.number().int().positive(),
  at: z.iso.datetime({ offset: true }),
};

/** 確定したイベント（events/<seq>.json の中身） */
export const conversationEventSchema = z.discriminatedUnion('type', [
  userMessage.extend(confirmed),
  turnStarted.extend(confirmed),
  assistantReasoning.extend(confirmed),
  assistantMessage.extend(confirmed),
  toolCall.extend(confirmed),
  toolResult.extend(confirmed),
  turnEnded.extend(confirmed),
  jobStarted.extend(confirmed),
  jobThink.extend(confirmed),
  jobImages.extend(confirmed),
  jobJudge.extend(confirmed),
  jobAdopted.extend(confirmed),
  jobIntervention.extend(confirmed),
  jobStopped.extend(confirmed),
]);
export type ConversationEvent = z.infer<typeof conversationEventSchema>;
export type ConversationEventType = ConversationEvent['type'];

/**
 * 増分の text は、画面が継ぎ足す増分。replace が true のときだけ、ここまでの全文で置き換える
 * （購読を始めたときに流す写し。つなぎ直した画面には途中の本文が残っているので、継ぎ足すと二重になるため）
 */
const replaceSchema = z.literal(true).optional();

/** 確定しないイベント。ファイルに書かず、ハブがメモリの写しから流す（SSE で id: を付けない） */
export const liveEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delta.text'),
    partId: partIdSchema,
    turn: turnSchema,
    text: z.string(),
    replace: replaceSchema,
  }),
  z.object({
    type: z.literal('delta.reasoning'),
    partId: partIdSchema,
    /** どの役の思考か。ジョブの役なら、どのジョブのどの回か */
    source: z.discriminatedUnion('role', [
      z.object({ role: z.literal('talk'), turn: turnSchema }),
      z.object({
        role: z.enum(['think', 'judge']),
        jobId: z.string().min(1),
        iteration: iterationSchema,
      }),
    ]),
    text: z.string(),
    replace: replaceSchema,
  }),
  z.object({
    type: z.literal('generation.progress'),
    jobId: z.string().min(1),
    iteration: iterationSchema,
    /** 0〜1 */
    progress: z.number().min(0).max(1),
    step: z.number().int().nonnegative().optional(),
    steps: z.number().int().positive().optional(),
    etaMs: z.number().nonnegative().optional(),
    /** 設定で有効なときだけ、途中の画像の URL */
    previewUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal('status'),
    status: z.enum(['queued', 'waiting-llm']),
  }),
  z.object({
    type: z.literal('job.held'),
    jobId: z.string().min(1),
    /** 人間の発言を聞くあいだ、そのジョブの LLM の段を待たせているか。解けたら false */
    held: z.boolean(),
  }),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;
