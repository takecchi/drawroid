import { z } from 'zod';

import { clipText, estimateTextTokens } from '../budget/estimate.js';
import type { StopConditions } from '../job/types.js';
import {
  sealMessages,
  type BudgetNote,
  type BudgetedMessages,
  type LlmCallOutcome,
  type LlmPort,
} from '../llm/port.js';
import { toLlmCallRecord, type LlmCallRecord } from '../llm/record.js';
import type { ModelWindow } from './budget.js';
import { InputOverBudgetError } from './inputs.js';
import { hasAnyStopCondition } from './stop.js';

/** 止める条件の自然言語として受け取る文字数の上限 */
export const STOP_TEXT_LIMIT = 300;
/** 変換できなかった部分として返させる件数と、1件の文字数の上限 */
const UNPARSED_LIMIT = { count: 3, chars: 80 };

const SYSTEM = [
  '画像生成のループを止める条件を、人間の文から読み取る。',
  '読み取れるのは、AI が意図どおりと判断したら止めるか（aiJudgement）、回数・枚数・時間（分）の上限だけ。',
  '文に書かれていない上限は null にする。推測で値を足さない。',
  'これらで表せない部分は、元の言い回しのまま unparsed に入れる。',
].join('\n');

// 上限は optional ではなく nullable にする: provider によっては構造化出力の欄をすべて必須にしか書けず、省略を表せないため
export const stopParseOutputSchema = z.object({
  aiJudgement: z.boolean(),
  maxIterations: z.number().int().positive().max(10_000).nullable(),
  maxImages: z.number().int().positive().max(100_000).nullable(),
  maxDurationMinutes: z
    .number()
    .positive()
    .max(7 * 24 * 60)
    .nullable(),
  unparsed: z.array(z.string().max(UNPARSED_LIMIT.chars)).max(UNPARSED_LIMIT.count),
});
export type StopParseOutput = z.infer<typeof stopParseOutputSchema>;

export type StopConditionsWarning = {
  kind: 'never-stops';
  message: string;
};

/** 変換の案。確定ではない。人間が確かめて直してから投入する */
export type StopConditionsDraft =
  | {
      ok: true;
      conditions: StopConditions;
      /** 止める条件で表せず、読み落とした部分。人間に見せる */
      unparsed: string[];
      warnings: StopConditionsWarning[];
      /** 入力を上限で切ったときの元の文字数 */
      clippedFrom?: number;
    }
  | { ok: false; reason: string };

export function buildStopParseInput(text: string, window: ModelWindow): BudgetedMessages {
  const clipped = clipText(text, STOP_TEXT_LIMIT);
  const notes: BudgetNote[] =
    clipped.clippedFrom === undefined
      ? []
      : [{ kind: 'clipped', section: 'stopText', from: clipped.clippedFrom, to: STOP_TEXT_LIMIT }];
  const user = `止める条件:\n${clipped.text}`;
  const inputTokenLimit = window.contextTokens - window.maxOutputTokens;
  const estimatedInputTokens = estimateTextTokens(SYSTEM) + estimateTextTokens(user);
  if (estimatedInputTokens > inputTokenLimit) {
    throw new InputOverBudgetError(estimatedInputTokens, inputTokenLimit);
  }
  return sealMessages(SYSTEM, [{ type: 'text', text: user }], {
    estimatedInputTokens,
    inputTokenLimit,
    notes,
  });
}

export function toStopConditions(output: StopParseOutput): StopConditions {
  return {
    aiJudgement: output.aiJudgement,
    ...(output.maxIterations !== null && { maxIterations: output.maxIterations }),
    ...(output.maxImages !== null && { maxImages: output.maxImages }),
    ...(output.maxDurationMinutes !== null && {
      maxDurationMs: Math.round(output.maxDurationMinutes * 60_000),
    }),
  };
}

export function warningsFor(conditions: StopConditions): StopConditionsWarning[] {
  return hasAnyStopCondition(conditions)
    ? []
    : [
        {
          kind: 'never-stops',
          message:
            'この条件では止まらない。AI の判断か、回数・枚数・時間の上限を1つ以上入れてから投入する',
        },
      ];
}

/**
 * 止める条件の自然言語を、構造化した止める条件の案に変換する。呼び出しは必ず記録する。
 */
// 案を確定させずに返す: 読み違えた上限でジョブが走り出すと、止まるはずのところで止まらないため。人間が確かめて直す
export async function parseStopConditions(args: {
  llm: LlmPort;
  text: string;
  signal: AbortSignal;
  now: () => Date;
  newCallId: (startedAt: Date) => string;
  /** ジョブに属さない呼び出しとして記録する（jobId は null） */
  record: (record: LlmCallRecord) => Promise<void>;
}): Promise<StopConditionsDraft> {
  const { llm } = args;
  const text = args.text.trim();
  if (text === '') return { ok: false, reason: '止める条件の文が空' };

  const info = llm.describe('think');
  const messages = buildStopParseInput(text, info.window);
  const startedAt = args.now();
  const outcome: LlmCallOutcome<StopParseOutput> = await llm.generateStructured({
    role: 'think',
    purpose: 'stop-parse',
    schema: stopParseOutputSchema,
    messages,
    signal: args.signal,
  });
  await args.record(
    toLlmCallRecord({
      callId: args.newCallId(startedAt),
      jobId: null,
      iteration: null,
      role: 'think',
      purpose: 'stop-parse',
      provider: info.provider,
      model: info.model,
      startedAt,
      messages,
      outcome,
    }),
  );
  if (!outcome.ok) return { ok: false, reason: outcome.reason };

  const conditions = toStopConditions(outcome.value);
  const clipped = messages.report.notes.find((n) => n.kind === 'clipped');
  return {
    ok: true,
    conditions,
    unparsed: outcome.value.unparsed,
    warnings: warningsFor(conditions),
    ...(clipped?.kind === 'clipped' && { clippedFrom: clipped.from }),
  };
}
