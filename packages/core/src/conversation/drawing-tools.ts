import { z } from 'zod';

import type { CandidateKind } from '../backend.js';
import { isBackendError } from '../backend-error.js';
import type { Budgets } from '../budget/settings.js';
import type { JobStore } from '../job/store.js';
import {
  MAX_REFERENCES_PER_REQUEST,
  stopConditionsChangeSchema,
  stopConditionsSchema,
  type InterventionRecord,
  type NewReference,
  type ReferenceRecord,
  type StopConditions,
  type StopConditionsChange,
} from '../job/types.js';
import { batchSizeProblem } from '../loop/budget.js';
import { createCarry } from '../loop/carry.js';
import { CANDIDATE_PARAMS } from '../loop/iteration-permissions.js';
import { hasAnyStopCondition } from '../loop/stop.js';
import type { Permissions } from '../permissions/permission.js';
import { adoptImage as adoptChosenImage } from '../selection/adopt.js';
import {
  indexOfTalkImageNumber,
  narrowPermissions,
  talkImageLabel,
  talkImageNumberSchema,
} from './drawing.js';
import type { ConversationStore } from './store.js';
import type { TalkTool, TalkToolContext, TalkToolOutcome } from './talk/tools.js';

/** 描くツールが使うジョブ実行器の口 */
export type DrawingRunner = {
  kick(): void;
  stop(jobId: string): Promise<void>;
  addInstruction(jobId: string, text: string): Promise<InterventionRecord>;
  changeStopConditions(jobId: string, change: StopConditionsChange): Promise<StopConditions>;
  /** 人間が選んだ画像を、走っているジョブに置く（お気に入りへの記録はしない） */
  adopt(jobId: string, image: { iteration: number; index: number }): Promise<InterventionRecord>;
  /** 走っているジョブに参照画像を添える。次の回の境目で、見る役が1度だけ見て要点にする */
  addReference(jobId: string, reference: NewReference): Promise<ReferenceRecord>;
};

/** 会話で走っている（まだ止まっていない）ジョブ。1つの会話で走るジョブは同時に1つ */
export async function activeJobOfConversation(
  jobs: Pick<JobStore, 'listJobIds' | 'readJob' | 'readState'>,
  conversationId: string,
): Promise<string | undefined> {
  for (const jobId of await jobs.listJobIds()) {
    const spec = await jobs.readJob(jobId);
    if (spec.kind !== 'auto' || spec.conversationId !== conversationId) continue;
    const state = await jobs.readState(jobId);
    if (state.status !== 'stopped') return jobId;
  }
  return undefined;
}

/**
 * 描くツールが使うもの。cli で描くツールを作るときに閉じ込めて渡す（副作用の無いツールの createReadOnlyTools と同じ形）。
 * 会話 ID とターンの番号は、会話の実行器が呼ぶたびに TalkToolContext で渡す
 */
export type DrawingToolDeps = {
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
  /**
   * 描き始める前に、画像のバックエンドに繋がるかを軽く確かめる（問い合わせ1回）。繋がらなければ投げる（BackendError なら理由つき）。
   * 省けば確かめない
   */
  checkBackend?(signal: AbortSignal): Promise<void>;
};

/** 描き始める前の確かめを待つ長さ。繋がるときは1回の問い合わせで返るので、描くたびに遅くはならない */
export const BACKEND_CHECK_TIMEOUT_MS = 5_000;

/** 描き始める前の確かめで、繋がらなかった理由を人に伝える形にする */
function backendProblem(error: unknown): string {
  const detail = isBackendError(error)
    ? error.kind === 'aborted'
      ? `${BACKEND_CHECK_TIMEOUT_MS / 1000} 秒待っても応答が無い`
      : error.message
    : error instanceof Error
      ? error.message
      : String(error);
  return `描き始められない: 画像のバックエンド（Forge / A1111）に繋がらない（${detail}）。バックエンドを起動するか、設定の画面でバックエンドの URL を確かめてから、もう一度頼んでもらう`;
}

const MAX_REQUEST_CHARS = 2000;
const MAX_INSTRUCTION_CHARS = 2000;

/** 会話で添えた画像の指し方。uploadId は、話す役の入力の発言に「（添えた画像: …）」として載る */
const attachmentsSchema = z
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
  .optional();

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
  attachments: attachmentsSchema.describe(
    '人間がこの会話で添えた画像を、参照画像として使うとき。発言の「（添えた画像: …）」の ID を書く',
  ),
});

// 知らない欄は断る: 前の 0 から数える欄（index）で渡されたとき、黙って省いた扱い（1枚目）にしないため
const adoptInputSchema = z
  .object({
    iteration: z.number().int().positive().optional().describe('回。省けば最新の回'),
    number: talkImageNumberSchema,
  })
  .strict();

const reviseInputSchema = z
  .object({
    instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS).optional(),
    stopConditions: stopConditionsChangeSchema.optional(),
    attachments: attachmentsSchema.describe(
      '人間がこの会話で添えた画像を、描いている絵の参照画像に足すとき。発言の「（添えた画像: …）」の ID を書く',
    ),
  })
  .refine(
    (input) =>
      input.instruction !== undefined ||
      input.stopConditions !== undefined ||
      (input.attachments ?? []).length > 0,
    { message: '指示・止める条件の変更・添えた画像のどれかを書く' },
  );

/**
 * 会話で添えた画像を、参照画像の形で読む。1枚でもこの会話に無ければ、どれも使わずに理由を返す
 * （一部だけ添えたまま進めると、人間が添えたつもりの画像が黙って欠けるため）
 */
async function readAttachments(
  conversations: ConversationStore,
  conversationId: string,
  attachments: readonly { uploadId: string; note?: string | undefined }[],
): Promise<{ ok: true; references: NewReference[] } | { ok: false; reason: string }> {
  // スキーマの max にしない: スキーマに合わない呼び出しは、理由を返さずに出力ごと出し直させるため、
  // 話す役が「何枚までか」を知って人間に伝えられない
  if (attachments.length > MAX_REFERENCES_PER_REQUEST) {
    return {
      ok: false,
      reason: `添えた画像を参照画像にできるのは、1 回に ${MAX_REFERENCES_PER_REQUEST} 枚まで（${attachments.length} 枚あった）。使う画像を選んで、もう一度呼ぶ`,
    };
  }
  const references: NewReference[] = [];
  for (const attachment of attachments) {
    const upload = await conversations.readUpload(conversationId, attachment.uploadId);
    if (upload === undefined) {
      return { ok: false, reason: `添えた画像 ${attachment.uploadId} はこの会話に無い` };
    }
    references.push({
      data: upload.data,
      mediaType: upload.mediaType,
      ...(attachment.note !== undefined && { note: attachment.note }),
    });
  }
  return { ok: true, references };
}

/** 結果の文を、話す役へ返す result と画面に出す summary の両方に使う */
function outcome(ok: boolean, text: string): TalkToolOutcome {
  return { ok, result: text, summary: text };
}

/** 止める条件を言葉にする（ツールの結果に出し、人間がログで見て言葉で直せるように） */
export function describeStopConditions(conditions: StopConditions): string {
  const parts = [
    ...(conditions.aiJudgement ? ['AI の判断'] : []),
    ...(conditions.maxIterations === undefined ? [] : [`${conditions.maxIterations} 回まで`]),
    ...(conditions.maxImages === undefined ? [] : [`${conditions.maxImages} 枚まで`]),
    ...(conditions.maxDurationMs === undefined ? [] : [durationLimit(conditions.maxDurationMs)]),
  ];
  return parts.join('・');
}

// 1 分に満たない上限は秒で書く: 分に丸めると「0 分まで」になり、人にも話す役にも意味が通らないため。
// 1 秒に満たない上限はミリ秒で書く: 秒に丸めると同じく「0 秒まで」になるため。秒に丸めて 60 になるなら分で書く（「60 秒まで」にしない）
function durationLimit(ms: number): string {
  if (ms < 1000) return `${ms} ミリ秒まで`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} 秒まで` : `${Math.round(ms / 60_000)} 分まで`;
}

/** 描くツール（副作用のあるもの）。会話の実行器に、副作用の無いツール（createReadOnlyTools）と並べて渡す */
export function createDrawingTools(deps: DrawingToolDeps): TalkTool[] {
  const activeJobOf = (context: TalkToolContext) =>
    activeJobOfConversation(deps.jobs, context.conversationId);

  const startDrawing: TalkTool = {
    name: 'start_drawing',
    description:
      '絵を描き始める。人間が描くよう求めたときだけ呼ぶ（「○○を描いて」）。描けるかを聞かれたとき・できることを聞かれたときは呼ばない（調べるツールで答える）。会話で描いている絵がすでにあるときは、revise_drawing か stop_drawing を使う',
    inputSchema: startInputSchema,
    async run(raw, context) {
      const input = startInputSchema.parse(raw);
      const running = await activeJobOf(context);
      if (running !== undefined) {
        return outcome(
          false,
          `ジョブ ${running} がまだ描いている。直すなら revise_drawing、やめて描き直すなら stop_drawing のあとで start_drawing を呼ぶ`,
        );
      }
      // ジョブを作る前に確かめる: 繋がらないまま描き始めると、ジョブがすぐ止まり、人には「描き始めた」と伝わってしまうため
      if (deps.checkBackend !== undefined) {
        try {
          await deps.checkBackend(AbortSignal.timeout(BACKEND_CHECK_TIMEOUT_MS));
        } catch (error) {
          return outcome(false, backendProblem(error));
        }
      }
      let permissions: Partial<Permissions> | undefined;
      if (input.permissions !== undefined) {
        const lists: Partial<Record<CandidateKind, string[]>> = {};
        for (const kind of new Set(Object.values(CANDIDATE_PARAMS))) {
          lists[kind] = await deps.candidateNames(kind);
        }
        const narrowed = narrowPermissions(await deps.humanPermissions(), input.permissions, lists);
        if (!narrowed.ok) return outcome(false, `許可を変えられない: ${narrowed.reason}`);
        permissions = narrowed.value;
      }
      const stopConditions = input.stopConditions ?? (await deps.defaultStopConditions());
      if (!hasAnyStopCondition(stopConditions)) {
        return outcome(false, 'この止める条件では止まらない。回数か AI の判断を足す');
      }
      const attached = await readAttachments(
        deps.conversations,
        context.conversationId,
        input.attachments ?? [],
      );
      if (!attached.ok) return outcome(false, attached.reason);
      const references = attached.references;
      const budgets = await deps.budgets();
      const tooMany = batchSizeProblem(input.batchSize ?? 1, budgets);
      if (tooMany !== undefined) return outcome(false, tooMany);
      const spec = await deps.jobs.createJob(
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
        deps.now(),
        references,
      );
      deps.runner.kick();
      return outcome(
        true,
        `ジョブ ${spec.jobId} で描き始めた。止める条件: ${describeStopConditions(stopConditions)}`,
      );
    },
  };

  const reviseDrawing: TalkTool = {
    name: 'revise_drawing',
    description:
      '描いている絵に、人間の指示（「次は夕焼けにして」など）を伝える・止める条件を変える・人間が添えた画像を参照画像に足す。次の回の境目から効く。描いている絵が無いときは使えない',
    inputSchema: reviseInputSchema,
    async run(raw, context) {
      const input = reviseInputSchema.parse(raw);
      const jobId = await activeJobOf(context);
      if (jobId === undefined) return outcome(false, '描いている絵が無い');
      // 添えた画像は先に全部読む: 無い画像があれば、指示も止める条件も変えずに断るため
      const attached = await readAttachments(
        deps.conversations,
        context.conversationId,
        input.attachments ?? [],
      );
      if (!attached.ok) return outcome(false, attached.reason);
      const done: string[] = [];
      if (input.instruction !== undefined) {
        await deps.runner.addInstruction(jobId, input.instruction);
        done.push('指示を伝えた');
      }
      if (input.stopConditions !== undefined) {
        const conditions = await deps.runner.changeStopConditions(jobId, input.stopConditions);
        done.push(`止める条件を ${describeStopConditions(conditions)} にした`);
      }
      for (const reference of attached.references) {
        await deps.runner.addReference(jobId, reference);
      }
      if (attached.references.length > 0) {
        done.push(`参照画像を ${attached.references.length} 枚添えた`);
      }
      return outcome(true, `ジョブ ${jobId} に${done.join('。')}（次の回の境目から効く）`);
    },
  };

  const stopDrawing: TalkTool = {
    name: 'stop_drawing',
    description:
      '描いている絵を止める。人間が止めるよう言ったときに呼ぶ（「止めて」）。「これでいい」と画像を選んだときは adopt_image を使う',
    inputSchema: z.object({}),
    async run(_raw, context) {
      const jobId = await activeJobOf(context);
      if (jobId === undefined) return outcome(false, '描いている絵が無い');
      await deps.runner.stop(jobId);
      return outcome(true, `ジョブ ${jobId} を止めた`);
    },
  };

  const adoptImage: TalkTool = {
    name: 'adopt_image',
    description:
      '人間が途中の画像を「これでいい」と選んだときに呼ぶ。その画像をお気に入りにして採る。「これでいいから次はこうして」なら、続けて revise_drawing で次の指示を伝える。「これでいい」だけなら、その画像で止まる',
    inputSchema: adoptInputSchema,
    async run(raw, context) {
      const input = adoptInputSchema.parse(raw);
      const jobId = await activeJobOf(context);
      if (jobId === undefined) return outcome(false, '描いている絵が無い');
      const generations = await deps.jobs.listGenerations(jobId);
      const iteration = input.iteration ?? generations.at(-1)?.iteration;
      if (iteration === undefined) return outcome(false, 'まだ画像が1枚もできていない');
      const image = { iteration, index: indexOfTalkImageNumber(input.number) };
      const label = talkImageLabel(image);
      // 画面の「採る」ボタンと同じ口を通す
      const adopted = await adoptChosenImage(
        { jobs: deps.jobs, runner: deps.runner, now: deps.now },
        jobId,
        image,
      );
      // 断りの文は話す役の数え方で書き直す: 共通の口の文は、置き場所のキー（0 から数える）を使うため
      if (!adopted.ok) {
        return outcome(
          false,
          adopted.reason === 'no-image'
            ? `${label}の画像は無い`
            : `絵がもう止まっていて、${label}を採れなかった`,
        );
      }
      return outcome(true, `${label}をお気に入りにして採った`);
    },
  };

  return [startDrawing, reviseDrawing, stopDrawing, adoptImage];
}

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
      problem: `${['conversations', ...(parsed.error.issues[0]?.path ?? []).map(String)].join('.')} の形が違う: ${parsed.error.issues[0]?.message ?? ''}`,
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
