import type {
  BudgetReport,
  BudgetedMessages,
  LlmAttempt,
  LlmCallOutcome,
  LlmPurpose,
  LlmRole,
} from './port.js';

/** 記録に残す入力。画像は中身ではなくキーで残す */
export type RecordedPart = { type: 'text'; text: string } | { type: 'image'; key: string };

/** LLM 呼び出し1回の記録（llm-calls/<callId>.json の中身） */
export type LlmCallRecord = {
  callId: string;
  /** ジョブに属さない呼び出し（止める条件の変換など）は null */
  jobId: string | null;
  /** 回に属さない、ジョブ単位の呼び出し（蒸留など）は null */
  iteration: number | null;
  role: LlmRole;
  purpose: LlmPurpose;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  input: { system: string; user: RecordedPart[] };
  budget: BudgetReport;
  attempts: LlmAttempt[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  outcome: { ok: true; value: unknown } | { ok: false; reason: string };
};

function sumOrNull(values: (number | null)[]): number | null {
  if (values.some((v) => v === null)) return null;
  return values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
}

export function toLlmCallRecord<T>(args: {
  callId: string;
  jobId: string | null;
  iteration: number | null;
  role: LlmRole;
  purpose: LlmPurpose;
  provider: string;
  model: string;
  startedAt: Date;
  messages: BudgetedMessages;
  outcome: LlmCallOutcome<T>;
}): LlmCallRecord {
  const { messages, outcome } = args;
  return {
    callId: args.callId,
    jobId: args.jobId,
    iteration: args.iteration,
    role: args.role,
    purpose: args.purpose,
    provider: args.provider,
    model: args.model,
    startedAt: args.startedAt.toISOString(),
    durationMs: outcome.attempts.reduce((sum, a) => sum + a.durationMs, 0),
    input: {
      system: messages.system,
      user: messages.user.map((part) =>
        part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', key: part.key },
      ),
    },
    budget: messages.report,
    attempts: outcome.attempts,
    usage: {
      inputTokens: sumOrNull(outcome.attempts.map((a) => a.usage.inputTokens)),
      outputTokens: sumOrNull(outcome.attempts.map((a) => a.usage.outputTokens)),
    },
    outcome: outcome.ok
      ? { ok: true, value: outcome.value }
      : { ok: false, reason: outcome.reason },
  };
}
