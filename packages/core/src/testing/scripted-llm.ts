import type {
  LlmCall,
  LlmCallOutcome,
  LlmPort,
  LlmPurpose,
  LlmRole,
  LlmRoleInfo,
} from '../llm/port.js';
import { DEFAULT_MODEL_WINDOW } from '../loop/budget.js';

/**
 * 呼び出しに対してモデルが返す生の値を決める。n は同じ用途の何回目の呼び出しか（0 始まり）。
 * 返した値は呼び出しのスキーマで検証され、合わなければ ok: false になる。
 */
export type Script = (call: LlmCall<unknown>, n: number) => unknown;

export type ScriptedLlmOptions = {
  roles?: Partial<Record<LlmRole, Partial<LlmRoleInfo>>>;
};

/** 1回の呼び出しが返す使用量（固定） */
export const SCRIPTED_USAGE = { inputTokens: 100, outputTokens: 20 } as const;

// 台本どおりに返す LLM。ループの試験で、本物の LLM の代わりに使う
export class ScriptedLlm implements LlmPort {
  /** 受け取った呼び出し。試験は「何を渡したか」をここで見る */
  readonly calls: LlmCall<unknown>[] = [];
  private readonly counts = new Map<LlmPurpose, number>();

  constructor(
    private readonly scripts: Partial<Record<LlmPurpose, Script>>,
    private readonly options: ScriptedLlmOptions = {},
  ) {}

  describe(role: LlmRole): LlmRoleInfo {
    return {
      provider: 'scripted',
      model: `scripted-${role}`,
      window: DEFAULT_MODEL_WINDOW,
      imageInput: true,
      ...this.options.roles?.[role],
    };
  }

  async generateStructured<T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>> {
    if (call.signal.aborted) throw abortError();
    this.calls.push(call as LlmCall<unknown>);
    const script = this.scripts[call.purpose];
    if (script === undefined) throw new Error(`台本に ${call.purpose} が無い`);
    const n = this.counts.get(call.purpose) ?? 0;
    this.counts.set(call.purpose, n + 1);

    const raw = await raceAbort(Promise.resolve(script(call as LlmCall<unknown>, n)), call.signal);
    const rawOutput = JSON.stringify(raw);
    const attempt = { rawOutput, usage: { ...SCRIPTED_USAGE }, durationMs: 1 };
    const parsed = call.schema.safeParse(raw);
    if (parsed.success) return { ok: true, value: parsed.data, attempts: [attempt] };
    const validationError = `スキーマに合わない: ${parsed.error.issues[0]?.message ?? ''}`;
    return {
      ok: false,
      reason: `構造化出力が 1 回続けてスキーマに合わなかった（最後: ${validationError}）`,
      attempts: [{ ...attempt, validationError }],
    };
  }
}

function abortError(): Error {
  const error = new Error('呼び手が止めた');
  error.name = 'AbortError';
  return error;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
