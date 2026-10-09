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
  parsePartialJson,
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

const ROLE_LABELS: Record<LlmRole, string> = { think: '考える役', judge: '見る役', talk: '話す役' };

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

/**
 * 本文に書かれた思考（<think>…</think>）を、流れている間に思考へ振り分ける。タグが増分の境目で割れても拾う。
 * 思考を本文の欄に書くローカル LLM で、思考が返答として画面に出ないようにするため
 */
class ThinkTagSplitter {
  private inThink = false;
  private pending = '';

  push(chunk: string): StreamEvent[] {
    const out: StreamEvent[] = [];
    let buffer = this.pending + chunk;
    this.pending = '';
    for (;;) {
      const tag = this.inThink ? THINK_CLOSE : THINK_OPEN;
      const at = buffer.toLowerCase().indexOf(tag);
      if (at === -1) break;
      this.emit(out, buffer.slice(0, at));
      buffer = buffer.slice(at + tag.length);
      this.inThink = !this.inThink;
    }
    // 終わりがタグの途中かもしれない分は、次の増分まで持つ
    const lower = buffer.toLowerCase();
    const tag = this.inThink ? THINK_CLOSE : THINK_OPEN;
    let keep = Math.min(tag.length - 1, lower.length);
    while (keep > 0 && !tag.startsWith(lower.slice(-keep))) keep -= 1;
    this.pending = buffer.slice(buffer.length - keep);
    this.emit(out, buffer.slice(0, buffer.length - keep));
    return out;
  }

  flush(): StreamEvent[] {
    const out: StreamEvent[] = [];
    this.emit(out, this.pending);
    this.pending = '';
    return out;
  }

  private emit(out: StreamEvent[], text: string): void {
    if (text !== '') out.push({ kind: this.inThink ? 'reasoning' : 'text', text });
  }
}

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
      if (i < this.options.validationRetries) call.onRetry?.();
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
    yield* config.toolCalling === 'json'
      ? this.streamStepAsJson(call, config)
      : this.streamStepWithTools(call, config);
  }

  /**
   * 1回の呼び出しを流し、増分をそのまま yield する。終わったら流し終えた中身を返す。
   * 流れの途中のエラーは投げる。
   */
  // ストリームの読みと yield を交互に進める: streamOnce は増分を callback で渡すので、溜めて順に出す
  private async *pumpStream(
    role: LlmRole,
    config: RoleConfig,
    request: Omit<Parameters<AiSdkLlm['streamOnce']>[2], 'onEvent'>,
  ): AsyncGenerator<StreamEvent, Streamed> {
    const queue: StreamEvent[] = [];
    let wake: (() => void) | undefined;
    let settled: { ok: true; value: Streamed } | { ok: false; error: unknown } | undefined;
    void this.streamOnce(role, config, {
      ...request,
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
        yield event;
        continue;
      }
      if (settled !== undefined) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    const outcome = settled as NonNullable<typeof settled>;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** 呼び出しの失敗を finish の部品にする。中断なら投げる */
  private callFailure(call: TalkStepCall, error: unknown): string {
    if (call.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return LENGTH_IN_MESSAGE.test(message)
      ? this.cutAtLimitReason(call.role, message)
      : `LLM の呼び出しに失敗した: ${clip(message, ERROR_SUMMARY_LIMIT)}`;
  }

  /** モデルのツール呼び出し（OpenAI 互換の tools / tool_calls など）で1ステップを回す */
  private async *streamStepWithTools(
    call: TalkStepCall,
    config: RoleConfig,
  ): AsyncIterable<TalkStepPart> {
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
      let streamed: Streamed;
      // 本文の欄に書かれた思考は、思考として流す
      const splitter = new ThinkTagSplitter();
      let reasoning = '';
      let body = '';
      const emit = function* (part: StreamEvent): Generator<TalkStepPart> {
        if (part.kind === 'reasoning') {
          reasoning += part.text;
          yield { type: 'reasoning-delta', text: part.text };
        } else {
          body += part.text;
          yield { type: 'text-delta', text: part.text };
        }
      };
      try {
        const stream = this.pumpStream(call.role, config, {
          instructions: call.messages.system,
          content,
          signal: call.signal,
          tools,
        });
        for (;;) {
          const next = await stream.next();
          if (next.done === true) {
            streamed = next.value;
            break;
          }
          const event = next.value;
          if (event.kind === 'reasoning') {
            reasoning += event.text;
            yield { type: 'reasoning-delta', text: event.text };
            continue;
          }
          for (const part of splitter.push(event.text)) yield* emit(part);
        }
        for (const part of splitter.flush()) yield* emit(part);
      } catch (error) {
        const failure = this.callFailure(call, error);
        attempts.push({
          rawOutput: '',
          usage: { inputTokens: null, outputTokens: null },
          durationMs: this.now() - started,
        });
        yield { type: 'finish', attempts, failure };
        return;
      }
      const durationMs = this.now() - started;
      // 開きタグをチャットのテンプレートが入れて、閉じタグだけが本文に来るモデル: 流し終えてから、
      // 閉じタグより前を思考に移して出し直す（流れている間は、閉じタグが来るまで思考と分からないため）
      const close = body.toLowerCase().lastIndexOf(THINK_CLOSE);
      if (close !== -1) {
        const thought = reasoning + body.slice(0, close);
        const rest = body.slice(close + THINK_CLOSE.length);
        yield { type: 'retry', reason: '本文に書かれた思考を、思考に移した' };
        if (thought !== '') yield { type: 'reasoning-delta', text: thought };
        if (rest !== '') yield { type: 'text-delta', text: rest };
      }
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

  /**
   * ツールの呼び出しに弱いモデルの逃げ道（toolCalling: json）。1ステップの出力を「reply か、ツールごとの tool」の
   * 構造化出力にし、今の構造化出力の口（native / json / text・検証と再試行）の上で回す。
   * 本文は、部分的な JSON から reply.text を取り出せる出し方のときだけ流し、取り出せなければ確定してから一度に出す。
   * 再試行が尽きたら、ツールを使わずに生の本文を出して失敗にする（検証していない出力から、描く・止めるを推し量らない）。
   */
  private async *streamStepAsJson(
    call: TalkStepCall,
    config: RoleConfig,
  ): AsyncIterable<TalkStepPart> {
    const schema = stepOutputSchemaOf(call.tools);
    const instructions =
      config.structuredOutput === 'native'
        ? call.messages.system
        : `${call.messages.system}\n次の JSON Schema に合う JSON だけを出力する:\n${JSON.stringify(
            z.toJSONSchema(schema),
          )}`;
    const output =
      config.structuredOutput === 'native'
        ? Output.object({ schema })
        : config.structuredOutput === 'json'
          ? Output.json()
          : undefined;
    const attempts: LlmAttempt[] = [];
    let previousError: string | undefined;
    let lastText = '';
    for (let i = 0; i <= this.options.validationRetries; i += 1) {
      const content = toContent(call.messages);
      if (previousError !== undefined) {
        content.push({
          type: 'text',
          text: `前の出力は受け付けられなかった（${previousError}）。JSON だけを出し直す。`,
        });
      }
      const started = this.now();
      let streamed: Streamed;
      // 部分的な JSON から取り出して流した reply.text。確定したあとに、残りだけを出すため
      let emitted = '';
      try {
        const stream = this.pumpStream(call.role, config, {
          instructions,
          content,
          signal: call.signal,
          ...(output === undefined ? {} : { output }),
        });
        let raw = '';
        for (;;) {
          const next = await stream.next();
          if (next.done === true) {
            streamed = next.value;
            break;
          }
          const event = next.value;
          if (event.kind === 'reasoning') {
            yield { type: 'reasoning-delta', text: event.text };
            continue;
          }
          raw += event.text;
          const partial = replyTextOf((await parsePartialJson(stripThinking(raw))).value);
          if (
            partial !== undefined &&
            partial.startsWith(emitted) &&
            partial.length > emitted.length
          ) {
            yield { type: 'text-delta', text: partial.slice(emitted.length) };
            emitted = partial;
          }
        }
      } catch (error) {
        const failure = this.callFailure(call, error);
        attempts.push({
          rawOutput: '',
          usage: { inputTokens: null, outputTokens: null },
          durationMs: this.now() - started,
        });
        yield { type: 'finish', attempts, failure };
        return;
      }
      const durationMs = this.now() - started;
      lastText = streamed.text;
      if (streamed.finishReason === 'length') {
        attempts.push({ rawOutput: streamed.text, usage: streamed.usage, durationMs });
        yield { type: 'finish', attempts, failure: this.cutAtLimitReason(call.role, undefined) };
        return;
      }
      let validationError: string;
      try {
        const parsed = schema.safeParse(extractJson(streamed.text));
        if (parsed.success) {
          attempts.push({ rawOutput: streamed.text, usage: streamed.usage, durationMs });
          const value = parsed.data;
          if (value.kind === 'reply') {
            if (value.text.startsWith(emitted)) {
              const rest = value.text.slice(emitted.length);
              if (rest !== '') yield { type: 'text-delta', text: rest };
            } else {
              // 流した途中の本文と確定した本文が食い違うときは、流した分を捨てて確定した本文を出す
              yield { type: 'retry', reason: '流した本文と確定した本文が食い違った' };
              if (value.text !== '') yield { type: 'text-delta', text: value.text };
            }
          } else {
            // ID は呼び出しごとに替える: 会話の中で tool.call と tool.result を組にする鍵なので、ステップをまたいで重ねない
            yield {
              type: 'tool-call',
              callId: `json-${globalThis.crypto.randomUUID()}`,
              name: value.name,
              input: value.input,
            };
          }
          yield { type: 'finish', attempts };
          return;
        }
        validationError = `スキーマに合わない: ${summarizeIssues(parsed.error)}`;
      } catch (error) {
        validationError = `JSON として読めない: ${error instanceof Error ? error.message : String(error)}`;
      }
      validationError = clip(validationError, ERROR_SUMMARY_LIMIT);
      attempts.push({
        rawOutput: streamed.text,
        usage: streamed.usage,
        durationMs,
        validationError,
      });
      previousError = validationError;
      if (i < this.options.validationRetries) yield { type: 'retry', reason: validationError };
    }
    // 生の本文を、確定する返答として出す。流した途中の本文は捨てる
    yield { type: 'retry', reason: '構造化出力の再試行が尽きた' };
    const rawText = stripThinking(lastText).trim();
    if (rawText !== '') yield { type: 'text-delta', text: rawText };
    yield {
      type: 'finish',
      attempts,
      failure: `ツールを呼べなかった（構造化出力が ${attempts.length} 回続けてスキーマに合わなかった。最後: ${previousError}）`,
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

/** 1ステップの出力のスキーマ。reply か、ツールごとの tool。ツールの説明は、それぞれの tool の変種に載せる */
function stepOutputSchemaOf(tools: readonly ToolSpec[]) {
  const reply = z
    .object({ kind: z.literal('reply'), text: z.string() })
    .describe('ツールを使わず、人間に返答する');
  const calls = tools.map((spec) =>
    z
      .object({
        kind: z.literal('tool'),
        name: z.literal(spec.name),
        input: spec.inputSchema,
      })
      .describe(spec.description),
  );
  return z.union([reply, ...calls]) as unknown as z.ZodType<
    { kind: 'reply'; text: string } | { kind: 'tool'; name: string; input: unknown }
  >;
}

/** 部分的な JSON が reply なら、そこまでの本文を返す */
function replyTextOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return record.kind === 'reply' && typeof record.text === 'string' ? record.text : undefined;
}
