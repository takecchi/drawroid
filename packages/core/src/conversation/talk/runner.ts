import type { LlmAttempt, LlmCallOutcome, LlmPort } from '../../llm/port.js';
import { toLlmCallRecord } from '../../llm/record.js';
import type { ConversationEvent } from '../events.js';
import type { ConversationHubs } from '../hub.js';
import type { ConversationStore } from '../store.js';
import { buildTalkInput, type TalkStepRecord } from './input.js';
import type { TalkLimits } from './limits.js';
import type { TalkTool } from './tools.js';

export type TalkRunnerDeps = {
  store: ConversationStore;
  hubs: ConversationHubs;
  /** いま使う LLM。未設定なら undefined（ターンは理由付きの error で閉じる） */
  llm: () => LlmPort | undefined;
  tools: readonly TalkTool[];
  /** ターンの始めに読む。設定で直した予算を、次のターンから効かせるため */
  limits: () => Promise<TalkLimits>;
  /** 会話のジョブの状態の短い文。ジョブが無ければ undefined */
  jobSummary?: (events: readonly ConversationEvent[]) => Promise<string | undefined>;
  now?: () => Date;
  /** LLM 呼び出しの ID。名前の順が呼び出しの順になる形にする */
  newCallId?: (now: Date) => string;
  log?: (line: string) => void;
};

/** 話す役の1ステップの結果（記録に残す値） */
type StepValue = { text: string; toolCalls: { name: string; input: unknown }[] };

/**
 * 会話の実行器。人間の発言を受けてターンを始め、話す役のステップを、ツールを実行しながら繰り返す。
 * ターンは会話ごとに直列で、走っている間に来た発言は、次のターンでまとめて読む。
 */
export class TalkRunner {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly running = new Set<string>();
  private readonly now: () => Date;
  private readonly newCallId: (now: Date) => string;
  private seq = 0;

  constructor(private readonly deps: TalkRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newCallId =
      deps.newCallId ??
      ((now) =>
        `${now.toISOString().replace(/[-:.]/g, '')}-${String(++this.seq).padStart(4, '0')}`);
  }

  /** 発言を受けたことを知らせる。走っていなければターンを始め、走っていれば順番待ちを流す */
  kick(conversationId: string): void {
    if (this.running.has(conversationId)) {
      this.deps.hubs.get(conversationId).live({ type: 'status', status: 'queued' });
    }
    const previous = this.chains.get(conversationId) ?? Promise.resolve();
    const run = previous.then(() => this.drain(conversationId));
    this.chains.set(
      conversationId,
      run.catch((error: unknown) => {
        this.deps.log?.(
          `drawroid: 会話 ${conversationId} のターンで予期しない失敗: ${String(error)}`,
        );
      }),
    );
  }

  /** 会話のターンが走り終えるまで待つ（試験のため） */
  async idle(conversationId: string): Promise<void> {
    for (;;) {
      const chain = this.chains.get(conversationId);
      await chain;
      if (this.chains.get(conversationId) === chain) return;
    }
  }

  private async drain(conversationId: string): Promise<void> {
    this.running.add(conversationId);
    try {
      while (await this.runTurn(conversationId)) {
        // 走っている間に来た発言を、続けて次のターンで読む
      }
    } finally {
      this.running.delete(conversationId);
    }
  }

  /** 未読の発言があればターンを1つ回す。回したら true */
  private async runTurn(conversationId: string): Promise<boolean> {
    const hub = this.deps.hubs.get(conversationId);
    const events = await readAll(this.deps.store, conversationId);
    const read = new Set(events.flatMap((e) => (e.type === 'turn.started' ? e.messageSeqs : [])));
    const unread = events
      .filter((e) => e.type === 'user.message' && !read.has(e.seq))
      .map((e) => e.seq);
    if (unread.length === 0) return false;
    const turn =
      Math.max(0, ...events.flatMap((e) => (e.type === 'turn.started' ? [e.turn] : []))) + 1;
    await hub.confirm({ type: 'turn.started', turn, messageSeqs: unread });

    const end = (outcome: 'done' | 'error', reason?: string) =>
      hub.confirm({
        type: 'turn.ended',
        turn,
        outcome,
        ...(reason === undefined ? {} : { reason }),
      });

    const llm = this.deps.llm();
    if (llm === undefined) {
      await end('error', 'LLM が未設定。LLM の設定で、provider と考える役のモデルを入れる');
      return true;
    }
    const limits = await this.deps.limits();
    const job = await this.deps.jobSummary?.(events);
    const info = llm.describe('talk');
    const signal = new AbortController().signal;
    const steps: TalkStepRecord[] = [];
    try {
      for (let step = 0; step < limits.maxSteps; step += 1) {
        const final = step === limits.maxSteps - 1;
        const messages = buildTalkInput({
          events,
          messageSeqs: unread,
          ...(job === undefined ? {} : { job }),
          steps,
          final,
          limits,
          window: info.window,
        });
        const textPart = `t${turn}-s${step}-text`;
        const reasoningPart = `t${turn}-s${step}-reasoning`;
        let text = '';
        let reasoning = '';
        const toolCalls: { callId: string; name: string; input: unknown }[] = [];
        let attempts: LlmAttempt[] = [];
        let failure: string | undefined;
        const startedAt = this.now();
        hub.live({ type: 'status', status: 'waiting-llm' });
        for await (const part of llm.streamStep({
          role: 'talk',
          messages,
          tools: final ? [] : this.deps.tools,
          signal,
        })) {
          switch (part.type) {
            case 'text-delta':
              text += part.text;
              hub.live({ type: 'delta.text', partId: textPart, turn, text: part.text });
              break;
            case 'reasoning-delta':
              reasoning += part.text;
              hub.live({
                type: 'delta.reasoning',
                partId: reasoningPart,
                source: { role: 'talk', turn },
                text: part.text,
              });
              break;
            case 'tool-call':
              toolCalls.push({ callId: part.callId, name: part.name, input: part.input });
              break;
            case 'retry':
              // 出し直す前の応答の増分は捨てる: 画面の写しも空にする
              text = '';
              reasoning = '';
              toolCalls.length = 0;
              hub.live({ type: 'delta.text', partId: textPart, turn, text: '', replace: true });
              hub.live({
                type: 'delta.reasoning',
                partId: reasoningPart,
                source: { role: 'talk', turn },
                text: '',
                replace: true,
              });
              break;
            case 'finish':
              attempts = part.attempts;
              failure = part.failure;
              break;
          }
        }
        const value: StepValue = {
          text,
          toolCalls: toolCalls.map(({ name, input }) => ({ name, input })),
        };
        const outcome: LlmCallOutcome<StepValue> =
          failure === undefined
            ? { ok: true, value, attempts }
            : { ok: false, reason: failure, attempts };
        await this.deps.store.writeLlmCall(
          conversationId,
          toLlmCallRecord({
            callId: this.newCallId(startedAt),
            jobId: null,
            iteration: null,
            role: 'talk',
            purpose: 'talk',
            provider: info.provider,
            model: info.model,
            startedAt,
            messages,
            outcome,
          }),
        );
        // 思考は画面とファイルにだけ残す。次のステップの入力（steps）には入れない
        if (reasoning !== '') {
          await hub.confirm({
            type: 'assistant.reasoning',
            turn,
            partId: reasoningPart,
            text: reasoning,
          });
        }
        if (text !== '') {
          await hub.confirm({ type: 'assistant.message', turn, partId: textPart, text });
        }
        if (failure !== undefined) {
          await end('error', failure);
          return true;
        }
        if (toolCalls.length === 0) {
          if (text === '') {
            await end('error', '話す役の返答が空だった');
          } else {
            await end('done');
          }
          return true;
        }
        for (const [i, call] of toolCalls.entries()) {
          await hub.confirm({
            type: 'tool.call',
            turn,
            callId: call.callId,
            name: call.name,
            input: call.input,
          });
          const tool = this.deps.tools.find((t) => t.name === call.name);
          let result: { ok: boolean; result: string; summary: string };
          try {
            if (tool === undefined) throw new Error(`知らないツール ${call.name}`);
            result = await tool.run(call.input, { conversationId, events, limits, signal });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result = { ok: false, result: `失敗した: ${message}`, summary: `失敗した: ${message}` };
          }
          await hub.confirm({
            type: 'tool.result',
            turn,
            callId: call.callId,
            ok: result.ok,
            summary: result.summary,
          });
          // 前置きの本文は、同じステップの最初のツールにだけ付ける
          steps.push({
            text: i === 0 ? text : '',
            tool: { name: call.name, input: call.input, result: result.result },
          });
        }
      }
      // 最後のステップはツールを渡さないので、ここに来るのはツールを呼び続けたときだけ
      await end('error', `ステップの上限（${limits.maxSteps}）までに返答が無かった`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await end('error', `ターンが失敗した: ${message}`);
    }
    return true;
  }
}

async function readAll(
  store: ConversationStore,
  conversationId: string,
): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await store.readEvents(conversationId, { after });
    events.push(...page.events);
    after = page.last;
    if (!page.more) return events;
  }
}
