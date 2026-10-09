import { z } from 'zod';

import type { CandidateKind } from '../backend.js';
import type { Budgets } from '../budget/settings.js';
import type { JobStore } from '../job/store.js';
import {
  stopConditionsChangeSchema,
  stopConditionsSchema,
  type InterventionRecord,
  type NewReference,
  type StopConditions,
  type StopConditionsChange,
} from '../job/types.js';
import type { ToolSpec } from '../llm/port.js';
import { createCarry } from '../loop/carry.js';
import { CANDIDATE_PARAMS } from '../loop/iteration-permissions.js';
import { hasAnyStopCondition } from '../loop/stop.js';
import type { Permissions } from '../permissions/permission.js';
import { narrowPermissions } from './drawing.js';
import type { ConversationStore } from './store.js';

/** 描くツールが使うジョブ実行器の口 */
export type DrawingRunner = {
  kick(): void;
  stop(jobId: string): Promise<void>;
  addInstruction(jobId: string, text: string): Promise<InterventionRecord>;
  changeStopConditions(jobId: string, change: StopConditionsChange): Promise<StopConditions>;
};

/** ツールを実行するときに、会話の実行器が渡すもの */
export type DrawingToolContext = {
  conversationId: string;
  /** いまのターンの番号。作ったジョブの job.json に残す */
  turn: number;
  /** 会話への橋渡しで包んだジョブの置き場所 */
  jobs: JobStore;
  runner: DrawingRunner;
  conversations: ConversationStore;
  /** 人間の許可（全体の既定）。話す役はこれを狭めることしかできない */
  humanPermissions(): Promise<Permissions>;
  /** 候補の種類ごとの、バックエンドが今持っている候補の名前 */
  candidateNames(kind: CandidateKind): Promise<string[]>;
  /** 止める条件を省いたときの既定（設定） */
  defaultStopConditions(): Promise<StopConditions>;
  /** 投入のときに解決してジョブへ写す予算 */
  budgets(): Promise<Budgets>;
  now(): Date;
};

/** ツールの結果。summary は表示と、話す役へ返す要約（予算で切るのは会話の実行器） */
export type ToolOutcome = { ok: boolean; summary: string; data?: Record<string, unknown> };

/** 話す役のツール1つ。LLM へは ToolSpec（名前・説明・引数のスキーマ）だけを渡し、実行は core が行う */
export type DrawingTool = ToolSpec & {
  run(input: unknown, context: DrawingToolContext): Promise<ToolOutcome>;
};

const MAX_REQUEST_CHARS = 2000;
const MAX_INSTRUCTION_CHARS = 2000;

const startInputSchema = z.object({
  request: z.string().trim().min(1).max(MAX_REQUEST_CHARS).describe('描くものの要点'),
  stopConditions: stopConditionsSchema
    .optional()
    .describe('止める条件。人間が言わなければ省く（設定の既定が使われる）'),
  batchSize: z.number().int().min(1).max(8).optional().describe('1回に描く枚数。省けば1'),
  permissions: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      '人間の許可を狭めるときだけ書く（使わないにする・候補の中の値で固定する・候補を絞る）。広げることはできない',
    ),
  attachments: z
    .array(
      z.object({
        uploadId: z.string().min(1),
        note: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('用途の言葉（「この構図で」など）'),
      }),
    )
    .optional()
    .describe('人間がこの会話で添えた画像を、参照画像として使うとき'),
});

const reviseInputSchema = z
  .object({
    instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS).optional(),
    stopConditions: stopConditionsChangeSchema.optional(),
  })
  .refine((input) => input.instruction !== undefined || input.stopConditions !== undefined, {
    message: '指示か止める条件の変更のどちらかを書く',
  });

/** 会話で走っている（まだ止まっていない）ジョブ。1つの会話で走るジョブは同時に1つ */
async function activeJobOf(context: DrawingToolContext): Promise<string | undefined> {
  for (const jobId of await context.jobs.listJobIds()) {
    const spec = await context.jobs.readJob(jobId);
    if (spec.kind !== 'auto' || spec.conversationId !== context.conversationId) continue;
    const state = await context.jobs.readState(jobId);
    if (state.status !== 'stopped') return jobId;
  }
  return undefined;
}

/** 止める条件を言葉にする（ツールの結果に出し、人間がログで見て言葉で直せるように） */
export function describeStopConditions(conditions: StopConditions): string {
  const parts = [
    ...(conditions.aiJudgement ? ['AI の判断'] : []),
    ...(conditions.maxIterations === undefined ? [] : [`${conditions.maxIterations} 回まで`]),
    ...(conditions.maxImages === undefined ? [] : [`${conditions.maxImages} 枚まで`]),
    ...(conditions.maxDurationMs === undefined
      ? []
      : [`${Math.round(conditions.maxDurationMs / 60_000)} 分まで`]),
  ];
  return parts.join('・');
}

const startDrawing: DrawingTool = {
  name: 'start_drawing',
  description:
    '絵を描き始める。人間が描くよう求めたときだけ呼ぶ（「○○を描いて」）。描けるかを聞かれたとき・できることを聞かれたときは呼ばない（調べるツールで答える）。会話で描いている絵がすでにあるときは、revise_drawing か stop_drawing を使う',
  inputSchema: startInputSchema,
  async run(raw, context) {
    const input = startInputSchema.parse(raw);
    const running = await activeJobOf(context);
    if (running !== undefined) {
      return {
        ok: false,
        summary: `ジョブ ${running} がまだ描いている。直すなら revise_drawing、やめて描き直すなら stop_drawing のあとで start_drawing を呼ぶ`,
      };
    }
    let permissions: Partial<Permissions> | undefined;
    if (input.permissions !== undefined) {
      const lists: Partial<Record<CandidateKind, string[]>> = {};
      for (const kind of new Set(Object.values(CANDIDATE_PARAMS))) {
        lists[kind] = await context.candidateNames(kind);
      }
      const narrowed = narrowPermissions(
        await context.humanPermissions(),
        input.permissions,
        lists,
      );
      if (!narrowed.ok) return { ok: false, summary: `許可を変えられない: ${narrowed.reason}` };
      permissions = narrowed.value;
    }
    const stopConditions = input.stopConditions ?? (await context.defaultStopConditions());
    if (!hasAnyStopCondition(stopConditions)) {
      return { ok: false, summary: 'この止める条件では止まらない。回数か AI の判断を足す' };
    }
    const references: NewReference[] = [];
    for (const attachment of input.attachments ?? []) {
      const upload = await context.conversations.readUpload(
        context.conversationId,
        attachment.uploadId,
      );
      if (upload === undefined) {
        return { ok: false, summary: `添えた画像 ${attachment.uploadId} はこの会話に無い` };
      }
      references.push({
        data: upload.data,
        mediaType: upload.mediaType,
        ...(attachment.note !== undefined && { note: attachment.note }),
      });
    }
    const budgets = await context.budgets();
    const spec = await context.jobs.createJob(
      {
        kind: 'auto',
        request: input.request,
        stopConditions,
        batchSize: input.batchSize ?? 1,
        ...(permissions !== undefined && { permissions }),
        budgets,
        conversationId: context.conversationId,
        turn: context.turn,
      },
      { status: 'queued', carry: createCarry(input.request, budgets).carry },
      context.now(),
      references,
    );
    context.runner.kick();
    return {
      ok: true,
      summary: `ジョブ ${spec.jobId} で描き始めた。止める条件: ${describeStopConditions(stopConditions)}`,
      data: { jobId: spec.jobId, stopConditions },
    };
  },
};

const reviseDrawing: DrawingTool = {
  name: 'revise_drawing',
  description:
    '描いている絵に、人間の指示を伝える・止める条件を変える。次の回の境目から効く。描いている絵が無いときは使えない',
  inputSchema: reviseInputSchema,
  async run(raw, context) {
    const input = reviseInputSchema.parse(raw);
    const jobId = await activeJobOf(context);
    if (jobId === undefined) return { ok: false, summary: '描いている絵が無い' };
    const done: string[] = [];
    if (input.instruction !== undefined) {
      await context.runner.addInstruction(jobId, input.instruction);
      done.push('指示を伝えた');
    }
    if (input.stopConditions !== undefined) {
      const conditions = await context.runner.changeStopConditions(jobId, input.stopConditions);
      done.push(`止める条件を ${describeStopConditions(conditions)} にした`);
    }
    return {
      ok: true,
      summary: `ジョブ ${jobId} に${done.join('。')}（次の回の境目から効く）`,
      data: { jobId },
    };
  },
};

const stopDrawing: DrawingTool = {
  name: 'stop_drawing',
  description: '描いている絵を止める。人間が止めるよう言ったときに呼ぶ',
  inputSchema: z.object({}),
  async run(_raw, context) {
    const jobId = await activeJobOf(context);
    if (jobId === undefined) return { ok: false, summary: '描いている絵が無い' };
    await context.runner.stop(jobId);
    return { ok: true, summary: `ジョブ ${jobId} を止めた`, data: { jobId } };
  },
};

/** 描くツール（副作用のあるもの）。会話の実行器（会話 E）が、副作用の無いツールと並べて話す役に渡す */
export const DRAWING_TOOLS: readonly DrawingTool[] = [startDrawing, reviseDrawing, stopDrawing];

/** 話す役が止める条件を省いたときの既定（設定に書かなければこれ） */
export const DEFAULT_DRAWING_STOP_CONDITIONS: StopConditions = {
  aiJudgement: true,
  maxIterations: 10,
};

const conversationSettingsSchema = z.object({
  defaultStopConditions: stopConditionsSchema.optional(),
});

/**
 * 設定（config.json の conversations）から、止める条件の既定を読む。読めない・止まらない値なら、既定に戻して理由を返す。
 */
// 書き損じで会話ごと止めない: 許可の設定と同じく、読めない欄は既定に戻して、理由を見せる
export function readDrawingStopConditions(raw: unknown): {
  conditions: StopConditions;
  problem?: string;
} {
  if (raw === undefined) return { conditions: DEFAULT_DRAWING_STOP_CONDITIONS };
  const parsed = conversationSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      conditions: DEFAULT_DRAWING_STOP_CONDITIONS,
      problem: `conversations の形が違う: ${parsed.error.issues[0]?.message ?? ''}`,
    };
  }
  const written = parsed.data.defaultStopConditions;
  if (written === undefined) return { conditions: DEFAULT_DRAWING_STOP_CONDITIONS };
  if (!hasAnyStopCondition(written)) {
    return {
      conditions: DEFAULT_DRAWING_STOP_CONDITIONS,
      problem: 'conversations.defaultStopConditions では止まらない（回数か AI の判断が要る）',
    };
  }
  return { conditions: written };
}
