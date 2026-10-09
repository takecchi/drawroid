import type { ZodType } from 'zod';
import type { ModelWindow } from '../loop/budget.js';

/** talk は会話で人間と話す役（ツールを呼ぶ）。既定は考える役と同じモデル */
export type LlmRole = 'think' | 'judge' | 'talk';
/**
 * stop-parse は止める条件の自然言語を構造化する呼び出し。考える役のモデルで行う。
 * ref-gist は見る役が参照画像を1度だけ見て要点を書く呼び出し。
 * talk は話す役の1ステップ。
 */
export type LlmPurpose = 'think' | 'judge' | 'distill' | 'stop-parse' | 'ref-gist' | 'talk';

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
  /**
   * モデルが自分で出す思考（reasoning）の増分を受ける。画面とファイルに見せるためで、次の入力には戻さない。
   * 思考を出さないモデル・設定（reasoning: none）では呼ばれない
   */
  onReasoning?: (text: string) => void;
};

/** 話す役に渡すツール。実行は core が行い、LLM には名前・説明・引数のスキーマだけを渡す */
export type ToolSpec = {
  name: string;
  /** 呼ぶべき時・呼ぶべきでない時を書く。システムプロンプトには足さず、ここに置く */
  description: string;
  /** 引数のスキーマ。呼び出しの引数は必ずこれで検証してから返す */
  inputSchema: ZodType<unknown>;
};

/** 話す役の1ステップ。ツールの実行もステップをまたぐ繰り返しも行わず、1回の応答だけを流す */
export type TalkStepCall = {
  role: LlmRole;
  messages: BudgetedMessages;
  tools: readonly ToolSpec[];
  signal: AbortSignal;
};

export type TalkStepPart =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  /** 引数はツールのスキーマで検証済み */
  | { type: 'tool-call'; callId: string; name: string; input: unknown }
  /**
   * ツールの引数が検証に落ち、同じステップをやり直す。それまでに流した本文・思考の増分は、
   * やり直す前の応答のもの（呼び手は捨ててよい）
   */
  | { type: 'retry'; reason: string }
  /** 最後に1回だけ来る。failure があれば、このステップは失敗（ツールの呼び出しは返していない） */
  | { type: 'finish'; attempts: LlmAttempt[]; failure?: string };

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
  /**
   * 話す役の1ステップを流す。最後に必ず finish を1回流す。ツールの引数の検証に落ちたら、検証エラーの要約だけを
   * 足して同じステップをやり直し、尽きたら finish の failure で返す。signal が中断されたときだけ、中断のエラーを投げる。
   */
  streamStep(call: TalkStepCall): AsyncIterable<TalkStepPart>;
}
