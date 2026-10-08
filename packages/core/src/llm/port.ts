import type { ZodType } from 'zod';

export type LlmRole = 'think' | 'judge';
export type LlmPurpose = 'think' | 'judge';

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

/** LLM との唯一の口。provider の差は実装（packages/llm）が吸収する */
export interface LlmPort {
  generateStructured<T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>>;
}
