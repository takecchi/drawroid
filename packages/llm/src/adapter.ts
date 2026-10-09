import type {
  LlmAttempt,
  LlmCall,
  LlmCallOutcome,
  LlmPort,
  LlmRole,
  LlmRoleInfo,
  LlmUsage,
} from '@drawroid/core';
import { DEFAULT_MODEL_WINDOW } from '@drawroid/core';
import {
  generateText,
  NoObjectGeneratedError,
  Output,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import { z, type ZodType } from 'zod';
import type { ResolvedRoles, RoleConfig } from './config.js';

const ERROR_SUMMARY_LIMIT = 300;

export type RoleModels = Record<LlmRole, { providerName: string; model: LanguageModel }>;

export type AdapterOptions = {
  validationRetries: number;
  networkRetries: number;
  /**
   * 役ごとの設定が、config.json の llm.roles のどの鍵にあるか。見る役を省いた設定では、見る役も think を使う。
   * 出力が上限で切れたときに、上げるべき設定の場所を名指すために使う。省けば役の名前と同じ鍵
   */
  configKeys?: Record<LlmRole, LlmRole>;
  /** 所要時間を測る時計（試験で差し替える） */
  now?: () => number;
};

const ROLE_LABELS: Record<LlmRole, string> = { think: '考える役', judge: '見る役' };

// サーバが length を HTTP のエラーとして返すことがある（本文に finish_reason=length などと書く）。AI SDK の結果の
// finishReason だけを見ると、その形を取りこぼす
const LENGTH_IN_MESSAGE = /finish_?reason\W{0,3}length/i;

/** 出力が上限（maxOutputTokens）で切れたことを表す。同じ上限で出し直しても同じ所で切れるので、出し直さない */
class OutputCutAtLimit extends Error {
  constructor(
    readonly rawOutput: string,
    readonly usage: LlmUsage,
    readonly detail?: string,
  ) {
    super('出力が上限で切れた');
  }
}

function clip(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}…`;
}

function toUsage(usage: LanguageModelUsage | undefined): LlmUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}

/** コードブロックや前後の文に包まれた JSON も取り出す（text の出し方のため） */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end < start) throw new SyntaxError('JSON のオブジェクトが見つからない');
  return JSON.parse(body.slice(start, end + 1));
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(全体)'}: ${issue.message}`)
    .join('; ');
}

type RawResponse = { text: string; usage: LlmUsage };

export class AiSdkLlm implements LlmPort {
  private readonly now: () => number;

  constructor(
    private readonly roles: ResolvedRoles,
    private readonly models: RoleModels,
    private readonly options: AdapterOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  describe(role: LlmRole): LlmRoleInfo {
    const config = this.roles[role];
    return {
      provider: this.models[role].providerName,
      model: config.model,
      window: {
        contextTokens: config.contextTokens ?? DEFAULT_MODEL_WINDOW.contextTokens,
        // 上限を送らないときも、入力の予算からは出力の分を空けておく: 入力で窓を埋めると出力が入らず length で切れるため
        maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MODEL_WINDOW.maxOutputTokens,
      },
      imageInput: config.imageInput,
    };
  }

  async generateStructured<T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>> {
    const config = this.roles[call.role];
    const hasImage = call.messages.user.some((part) => part.type === 'image');
    if (hasImage && !config.imageInput) {
      return {
        ok: false,
        reason: `${call.role} の役のモデル ${config.model} は、設定で画像入力に対応していないとされている`,
        attempts: [],
      };
    }

    const attempts: LlmAttempt[] = [];
    let previousError: string | undefined;
    for (let i = 0; i <= this.options.validationRetries; i += 1) {
      const started = this.now();
      let raw: RawResponse;
      try {
        raw = await this.callOnce(call, config, previousError);
      } catch (error) {
        if (call.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof OutputCutAtLimit || LENGTH_IN_MESSAGE.test(message)) {
          const cut = error instanceof OutputCutAtLimit ? error : undefined;
          attempts.push({
            rawOutput: cut?.rawOutput ?? '',
            usage: cut?.usage ?? { inputTokens: null, outputTokens: null },
            durationMs: this.now() - started,
          });
          return {
            ok: false,
            reason: this.cutAtLimitReason(call.role, cut === undefined ? message : cut.detail),
            attempts,
          };
        }
        attempts.push({
          rawOutput: '',
          usage: { inputTokens: null, outputTokens: null },
          durationMs: this.now() - started,
        });
        return {
          ok: false,
          reason: `LLM の呼び出しに失敗した: ${clip(message, ERROR_SUMMARY_LIMIT)}`,
          attempts,
        };
      }
      const durationMs = this.now() - started;

      let validationError: string;
      try {
        const parsed = call.schema.safeParse(extractJson(raw.text));
        if (parsed.success) {
          attempts.push({ rawOutput: raw.text, usage: raw.usage, durationMs });
          return { ok: true, value: parsed.data, attempts };
        }
        validationError = `スキーマに合わない: ${summarizeIssues(parsed.error)}`;
      } catch (error) {
        validationError = `JSON として読めない: ${error instanceof Error ? error.message : String(error)}`;
      }
      validationError = clip(validationError, ERROR_SUMMARY_LIMIT);
      attempts.push({ rawOutput: raw.text, usage: raw.usage, durationMs, validationError });
      previousError = validationError;
    }
    return {
      ok: false,
      reason: `構造化出力が ${attempts.length} 回続けてスキーマに合わなかった（最後: ${previousError}）`,
      attempts,
    };
  }

  private async callOnce<T>(
    call: LlmCall<T>,
    config: RoleConfig,
    previousError: string | undefined,
  ): Promise<RawResponse> {
    const instructions =
      config.structuredOutput === 'native'
        ? call.messages.system
        : `${call.messages.system}\n次の JSON Schema に合う JSON だけを出力する:\n${JSON.stringify(
            z.toJSONSchema(call.schema as ZodType),
          )}`;
    const content: Exclude<ModelMessage['content'], string> = call.messages.user.map((part) =>
      part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : { type: 'file' as const, data: part.data, mediaType: part.mediaType },
    );
    // 失敗した出力の全文は積まない: 再試行のたびに入力が膨らむため。足すのは直前の検証エラーの要約だけ
    if (previousError !== undefined) {
      content.push({
        type: 'text',
        text: `前の出力は受け付けられなかった（${previousError}）。JSON だけを出し直す。`,
      });
    }
    const messages = [{ role: 'user', content }] as ModelMessage[];
    const output =
      config.structuredOutput === 'native'
        ? Output.object({ schema: call.schema })
        : config.structuredOutput === 'json'
          ? Output.json()
          : undefined;
    try {
      const result = await generateText({
        model: this.models[call.role].model,
        instructions,
        messages,
        ...(config.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: config.maxOutputTokens }),
        maxRetries: this.options.networkRetries,
        abortSignal: call.signal,
        ...(output === undefined ? {} : { output }),
      });
      if (result.finishReason === 'length') {
        throw new OutputCutAtLimit(result.text, toUsage(result.usage));
      }
      return { text: result.text, usage: toUsage(result.usage) };
    } catch (error) {
      // 検証は core のスキーマで自前で行う。AI SDK の検証で落ちた出力も、生の文字列として受け取る。
      // ただし上限で切れたものは別にする: スキーマに合わないとして同じ上限で出し直しても、同じ所で切れるため
      if (NoObjectGeneratedError.isInstance(error)) {
        if (error.finishReason === 'length') {
          throw new OutputCutAtLimit(error.text ?? '', toUsage(error.usage));
        }
        return { text: error.text ?? '', usage: toUsage(error.usage) };
      }
      throw error;
    }
  }

  // どこで切れたか・何を変えればよいかを名指す: 「上限を上げる」だけでは、画面のどの欄・config.json のどの鍵か、
  // drawroid と LLM のどちらの設定かが分からないため
  private cutAtLimitReason(role: LlmRole, detail: string | undefined): string {
    const key = this.options.configKeys?.[role] ?? role;
    const config = this.roles[role];
    const lines: string[] = [];
    if (config.maxOutputTokens === undefined) {
      // 上限を書いていない役は、drawroid は上限を送らず LLM 側の設定に任せている
      lines.push(
        `${ROLE_LABELS[role]}の出力が、LLM 側の出力の上限で切れた（drawroid は出力の上限を送っていない）。`,
        'LLM のサーバかモデルの設定で、出力の上限（max_tokens など）や文脈の長さを上げる。',
      );
    } else {
      const suggested = Math.max(config.maxOutputTokens * 2, 2048);
      const inherited =
        key === role ? '' : `${ROLE_LABELS[role]}は${ROLE_LABELS[key]}の設定を使っているので、`;
      lines.push(
        `${ROLE_LABELS[role]}の出力が、出力の上限（maxOutputTokens = ${config.maxOutputTokens}）で切れた。`,
        `${inherited}LLM の設定の${ROLE_LABELS[key]}の「出力の上限（トークン）」（config.json の llm.roles.${key}.maxOutputTokens）を ${suggested} 以上に上げるか、空にして LLM 側の設定に任せる。`,
      );
    }
    lines.push(
      '考える過程（reasoning）を出すモデルでは、その分も出力の上限に数えられる。上げても切れるなら、サーバかモデルの側で考える過程を切る。',
    );
    if (detail !== undefined) lines.push(`（元のエラー: ${clip(detail, ERROR_SUMMARY_LIMIT)}）`);
    return lines.join('');
  }
}
