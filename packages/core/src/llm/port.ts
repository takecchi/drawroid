import type { ZodType } from 'zod';
import type { ModelWindow } from '../loop/budget.js';

export type LlmRole = 'think' | 'judge';
/** stop-parse は止める条件の自然言語を構造化する呼び出し。考える役のモデルで行う */
export type LlmPurpose = 'think' | 'judge' | 'distill' | 'stop-parse';

export type TextPart = { type: 'text'; text: string };
export type ImagePart = {
  type: 'image';
  /** データディレクトリ内でこの画像を指すキー。記録には中身ではなくこれを残す */
  key: string;
  data: Uint8Array;
  mediaType: string;
};

/** 予算で切った・落とした・持ち越したもの。LLM 呼び出しの記録に載せる */
export type BudgetNote =
  | { kind: 'clipped'; section: string; from: number; to: number }
  | { kind: 'dropped'; section: string; reason: string };

export type BudgetReport = {
  estimatedInputTokens: number;
  inputTokenLimit: number;
  notes: BudgetNote[];
};

declare const budgeted: unique symbol;

/**
 * 組み立て器だけが作れる入力。LlmPort はこれしか受け取らない。
 */
// ただの { system, user } を受け取る形にしない: 予算を通らずに組んだ入力を渡せてしまうため
export type BudgetedMessages = {
  readonly [budgeted]: true;
  system: string;
  user: (TextPart | ImagePart)[];
  report: BudgetReport;
};

export function sealMessages(
  system: string,
  user: (TextPart | ImagePart)[],
  report: BudgetReport,
): BudgetedMessages {
  return { system, user, report } as BudgetedMessages;
}

export type LlmUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type LlmAttempt = {
  rawOutput: string;
  usage: LlmUsage;
  durationMs: number;
  /** スキーマ検証に失敗したときの短い理由 */
  validationError?: string;
};

export type LlmCallOutcome<T> =
  | { ok: true; value: T; attempts: LlmAttempt[] }
  | { ok: false; reason: string; attempts: LlmAttempt[] };

export type LlmCall<T> = {
  role: LlmRole;
  purpose: LlmPurpose;
  schema: ZodType<T>;
  messages: BudgetedMessages;
  signal: AbortSignal;
};

/** 役割に割り当てたモデル。記録と入力の組み立てに使う */
export type LlmRoleInfo = {
  provider: string;
  model: string;
  window: ModelWindow;
  imageInput: boolean;
};

/** LLM との唯一の口。provider の差は実装（packages/llm）が吸収する */
export interface LlmPort {
  describe(role: LlmRole): LlmRoleInfo;
  /**
   * 構造化出力を検証して返す。検証の失敗と呼び出しの失敗は ok: false で返す。
   * signal が中断されたときだけ、中断のエラーを投げる。
   */
  generateStructured<T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>>;
}
