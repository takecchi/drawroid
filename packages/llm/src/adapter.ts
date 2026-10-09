import type {
  BudgetedMessages,
  LlmAttempt,
  LlmCall,
  LlmCallOutcome,
  LlmPort,
  LlmRole,
  LlmRoleInfo,
  LlmUsage,
  TalkStepCall,
  TalkStepPart,
  ToolSpec,
} from '@drawroid/core';
import { DEFAULT_MODEL_WINDOW } from '@drawroid/core';
import {
  jsonSchema,
  Output,
  streamText,
  tool,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
  type UserContent,
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

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * 本文に混ざった思考（<think>…</think>）を外す。思考の中の { やコードブロックを、答えの JSON として読まないため。
 * 閉じタグだけが来る（開きタグはチャットのテンプレートが入れる）モデルでは、最後の閉じタグより前を思考とみなす。
 * 閉じないまま終わった思考（出力の上限で切れたなど）は、開きタグから後を外す。
 */
function stripThinking(text: string): string {
  let body = text.replace(THINK_BLOCK, '');
  const close = body.toLowerCase().lastIndexOf(THINK_CLOSE);
  if (close !== -1) body = body.slice(close + THINK_CLOSE.length);
  const open = body.toLowerCase().indexOf(THINK_OPEN);
  if (open !== -1) body = body.slice(0, open);
  return body;
}

/** コードブロックや前後の文に包まれた JSON も取り出す（text の出し方のため）。本文に混ざった思考は読まない */
export function extractJson(text: string): unknown {
  const answer = stripThinking(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer);
  const body = fenced?.[1] ?? answer;
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

type StreamedToolCall = { callId: string; name: string; input: unknown; invalid: boolean };

/** 1回の呼び出しを流し終えたときの中身 */
type Streamed = {
  text: string;
  usage: LlmUsage;
  finishReason: FinishReason | undefined;
  toolCalls: StreamedToolCall[];
};

/** 流れている間に呼び手へ渡すもの */
type StreamEvent = { kind: 'text' | 'reasoning'; text: string };

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('呼び手が止めた');
  error.name = 'AbortError';
  return error;
}

function toContent(messages: BudgetedMessages): Exclude<UserContent, string> {
  return messages.user.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'file' as const, data: part.data, mediaType: part.mediaType },
  );
}

// 実行の関数は渡さない: ツールの実行・許可の検証・ステップをまたぐ繰り返しは core が行う。
// 引数は AI SDK に検証させず（JSON として読むだけ）、core のスキーマで検証して要約をそろえる
function toToolSet(tools: readonly ToolSpec[]): ToolSet {
  return Object.fromEntries(
    tools.map((spec) => [
      spec.name,
      tool({
        description: spec.description,
        inputSchema: jsonSchema(z.toJSONSchema(spec.inputSchema as ZodType) as never),
      }),
    ]),
  );
}

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
    const content = toContent(call.messages);
    // 失敗した出力の全文は積まない: 再試行のたびに入力が膨らむため。足すのは直前の検証エラーの要約だけ
    if (previousError !== undefined) {
      content.push({
        type: 'text',
        text: `前の出力は受け付けられなかった（${previousError}）。JSON だけを出し直す。`,
      });
    }
    // native でも出力は AI SDK に読ませない: スキーマを送るためだけに使い、検証は core のスキーマで自前で行う
    const output =
      config.structuredOutput === 'native'
        ? Output.object({ schema: call.schema })
        : config.structuredOutput === 'json'
          ? Output.json()
          : undefined;
    const onReasoning = call.onReasoning;
    const streamed = await this.streamOnce(call.role, config, {
      instructions,
      content,
      signal: call.signal,
      ...(output === undefined ? {} : { output }),
      ...(onReasoning === undefined
        ? {}
        : { onEvent: (event) => event.kind === 'reasoning' && onReasoning(event.text) }),
    });
    // 上限で切れたものは別にする: スキーマに合わないとして同じ上限で出し直しても、同じ所で切れるため
    if (streamed.finishReason === 'length') {
      throw new OutputCutAtLimit(streamed.text, streamed.usage);
    }
    return { text: streamed.text, usage: streamed.usage };
  }

  /**
   * 1回の呼び出しを流し、本文・思考の増分を onEvent へ渡す。思考は reasoning: none なら渡さない。
   * 流れの途中のエラーは投げる。signal が中断されたら中断のエラーを投げる。
   */
  private async streamOnce(
    role: LlmRole,
    config: RoleConfig,
    request: {
      instructions: string;
      content: Exclude<UserContent, string>;
      signal: AbortSignal;
      output?: Parameters<typeof streamText>[0]['output'];
      tools?: ToolSet;
      onEvent?: (event: StreamEvent) => void;
    },
  ): Promise<Streamed> {
    const result = streamText({
      model: this.models[role].model,
      instructions: request.instructions,
      messages: [{ role: 'user', content: request.content }] as ModelMessage[],
      ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
      maxRetries: this.options.networkRetries,
      abortSignal: request.signal,
      ...(request.output === undefined ? {} : { output: request.output }),
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      // 流れの中の error の部品で受けて投げる。既定の console への出力はさせない
      onError: () => undefined,
    });
    const streamed: Streamed = {
      text: '',
      usage: { inputTokens: null, outputTokens: null },
      finishReason: undefined,
      toolCalls: [],
    };
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          streamed.text += part.text;
          request.onEvent?.({ kind: 'text', text: part.text });
          break;
        case 'reasoning-delta':
          if (config.reasoning !== 'none')
            request.onEvent?.({ kind: 'reasoning', text: part.text });
          break;
        case 'tool-call':
          streamed.toolCalls.push({
            callId: part.toolCallId,
            name: part.toolName,
            input: part.input,
            invalid: part.dynamic === true && part.invalid === true,
          });
          break;
        case 'finish':
          streamed.finishReason = part.finishReason;
          streamed.usage = toUsage(part.totalUsage);
          break;
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        default:
          break;
      }
    }
    if (request.signal.aborted) throw abortError(request.signal);
    return streamed;
  }

  async *streamStep(call: TalkStepCall): AsyncIterable<TalkStepPart> {
    const config = this.roles[call.role];
    const hasImage = call.messages.user.some((part) => part.type === 'image');
    if (hasImage && !config.imageInput) {
      yield {
        type: 'finish',
        attempts: [],
        failure: `${call.role} の役のモデル ${config.model} は、設定で画像入力に対応していないとされている`,
      };
      return;
    }
    const tools = toToolSet(call.tools);
    const attempts: LlmAttempt[] = [];
    let previousError: string | undefined;
    for (let i = 0; i <= this.options.validationRetries; i += 1) {
      const content = toContent(call.messages);
      // 失敗した呼び出しの全文は積まない: 足すのは直前の検証エラーの要約だけ
      if (previousError !== undefined) {
        content.push({
          type: 'text',
          text: `前の応答のツールの呼び出しは受け付けられなかった（${previousError}）。呼び直す。`,
        });
      }
      const started = this.now();
      // 流れてきた増分を、そのまま呼び手へ流す（ストリームの読みと yield を交互に進める）
      const queue: StreamEvent[] = [];
      let wake: (() => void) | undefined;
      let settled: { ok: true; value: Streamed } | { ok: false; error: unknown } | undefined;
      void this.streamOnce(call.role, config, {
        instructions: call.messages.system,
        content,
        signal: call.signal,
        tools,
        onEvent: (event) => {
          queue.push(event);
          wake?.();
        },
      }).then(
        (value) => {
          settled = { ok: true, value };
          wake?.();
        },
        (error: unknown) => {
          settled = { ok: false, error };
          wake?.();
        },
      );
      for (;;) {
        const event = queue.shift();
        if (event !== undefined) {
          yield {
            type: event.kind === 'text' ? 'text-delta' : 'reasoning-delta',
            text: event.text,
          };
          continue;
        }
        if (settled !== undefined) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      const durationMs = this.now() - started;
      const outcome = settled as NonNullable<typeof settled>;
      if (!outcome.ok) {
        if (call.signal.aborted) throw outcome.error;
        const message =
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        attempts.push({
          rawOutput: '',
          usage: { inputTokens: null, outputTokens: null },
          durationMs,
        });
        yield {
          type: 'finish',
          attempts,
          failure: LENGTH_IN_MESSAGE.test(message)
            ? this.cutAtLimitReason(call.role, message)
            : `LLM の呼び出しに失敗した: ${clip(message, ERROR_SUMMARY_LIMIT)}`,
        };
        return;
      }
      const streamed = outcome.value;
      const rawOutput = rawOutputOf(streamed);
      if (streamed.finishReason === 'length') {
        attempts.push({ rawOutput, usage: streamed.usage, durationMs });
        yield { type: 'finish', attempts, failure: this.cutAtLimitReason(call.role, undefined) };
        return;
      }
      const checked = checkToolCalls(streamed.toolCalls, call.tools);
      if (checked.ok) {
        attempts.push({ rawOutput, usage: streamed.usage, durationMs });
        yield* checked.parts;
        yield { type: 'finish', attempts };
        return;
      }
      const validationError = clip(checked.error, ERROR_SUMMARY_LIMIT);
      attempts.push({ rawOutput, usage: streamed.usage, durationMs, validationError });
      previousError = validationError;
      if (i < this.options.validationRetries) yield { type: 'retry', reason: validationError };
    }
    yield {
      type: 'finish',
      attempts,
      failure: `ツールの呼び出しが ${attempts.length} 回続けてスキーマに合わなかった（最後: ${previousError}）`,
    };
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

/** 記録に残す生の出力。本文と、ツールの呼び出し（名前と引数）をそのまま並べる */
function rawOutputOf(streamed: Streamed): string {
  if (streamed.toolCalls.length === 0) return streamed.text;
  const calls = streamed.toolCalls.map((c) => ({ name: c.name, input: c.input }));
  return `${streamed.text}${streamed.text === '' ? '' : '\n'}${JSON.stringify(calls)}`;
}

/** ツールの呼び出しを、ツールのスキーマで検証する。1つでも落ちたら、全体を出し直させる */
function checkToolCalls(
  calls: readonly StreamedToolCall[],
  tools: readonly ToolSpec[],
): { ok: true; parts: TalkStepPart[] } | { ok: false; error: string } {
  const parts: TalkStepPart[] = [];
  for (const call of calls) {
    const spec = tools.find((t) => t.name === call.name);
    if (spec === undefined) return { ok: false, error: `知らないツール ${call.name} を呼んだ` };
    if (call.invalid) return { ok: false, error: `${call.name} の引数が JSON として読めない` };
    const parsed = spec.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        ok: false,
        error: `${call.name} の引数がスキーマに合わない: ${summarizeIssues(parsed.error)}`,
      };
    }
    parts.push({ type: 'tool-call', callId: call.callId, name: call.name, input: parsed.data });
  }
  return { ok: true, parts };
}
