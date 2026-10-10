import type { StopReason } from '../../job/types.js';
import type { LlmAttempt, LlmCallOutcome, LlmPort } from '../../llm/port.js';
import { toLlmCallRecord } from '../../llm/record.js';
import type { ConversationEvent } from '../events.js';
import type { ConversationHubs } from '../hub.js';
import type { StoppedJob } from '../job-bridge.js';
import type { ConversationStore } from '../store.js';
import { buildTalkInput, type TalkStepRecord } from './input.js';
import { DEFAULT_TALK_LIMITS, type TalkLimits } from './limits.js';
import type { TalkTool } from './tools.js';
import { TalkWindowReader, type TalkWindow } from './window.js';

type TurnEnd = (outcome: 'done' | 'interrupted' | 'error', reason?: string) => Promise<unknown>;

/**
 * LLM が未設定でターンを閉じるときの理由。画面はこの文を見て、設定の画面の LLM の欄へのリンクを添える
 * （呼び方は、設定の画面「設定」の欄の名前「LLM の設定」にそろえる）
 */
export const LLM_NOT_CONFIGURED_REASON =
  'LLM が未設定。設定の画面の「LLM の設定」で、provider と考える役のモデルを入れる';

/**
 * 同じターンで同じ引数のツールをもう一度呼んだときの断りの理由。画面はこの文を見て、人の言葉の要約に置き換える
 */
/**
 * ツールが投げたときに、結果の文の頭に付ける言葉。画面は、これを外してから理由を読む
 * （外さないと「できなかった: 失敗した: …」と二重になり、REPEATED_TOOL_CALL_REASON とも照らせないため）
 */
export const TOOL_THREW_PREFIX = '失敗した: ';

export const REPEATED_TOOL_CALL_REASON =
  'このターンで同じ引数ですでに呼んだので、もう一度は走らせなかった。結果は前のとおり';

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
  /**
   * 会話のジョブへの口。省けばジョブには触れない。
   * - active: 会話の走っている（止まっていない）ジョブ。無ければ undefined
   * - hold: そのジョブの LLM の段を待たせる。戻り値で解く
   * - stop: そのジョブを止める（人間の停止）
   */
  jobs?: {
    active(conversationId: string): Promise<string | undefined>;
    hold(jobId: string): () => void;
    stop(jobId: string): Promise<void>;
  };
  now?: () => Date;
  /** LLM 呼び出しの ID。名前の順が呼び出しの順になる形にする */
  newCallId?: (now: Date) => string;
  log?: (line: string) => void;
};

/** 話す役の1ステップの結果（記録に残す値） */
type StepValue = { text: string; toolCalls: { name: string; input: unknown }[] };

/** 走っているターン1つの状態。人間の割り込みの置き場 */
type ActiveTurn = {
  /** ターンが始まって、読んだ発言が決まるまでは undefined */
  readSeqs: Set<number> | undefined;
  /** 打ち切りが求められた。LLM の出力を待っていれば即座に、ツールの実行中ならツールが終わってから打ち切る */
  interrupting: boolean;
  /** いま LLM の出力を待っているなら、その呼び出しの controller */
  llm: AbortController | undefined;
  phase: 'llm' | 'tool' | 'other';
  finished: boolean;
  done: Promise<void>;
  finish(): void;
};

const INTERRUPTED_REASON = '人間の割り込みで打ち切った';

/**
 * 止まった理由ごとに、話す役から話しかけるか。人が止めた・人が選んで止まったときは、止まったことも結果も人が知っているので話しかけない
 */
const SPEAKS_AFTER_STOP: Record<StopReason['kind'], boolean> = {
  ai: true,
  'limit:iterations': true,
  'limit:duration': true,
  'limit:images': true,
  error: true,
  human: false,
  adopted: false,
};

export function speaksAfterJobStop(reason: StopReason): boolean {
  return SPEAKS_AFTER_STOP[reason.kind];
}

/** 話しかけてよいかを見るときに、会話の末尾から1回に読む件数 */
const STOP_SCAN_PAGE = 50;

/**
 * 会話の実行器。人間の発言（または会話のジョブの止まり）を受けてターンを始め、話す役のステップを、ツールを実行しながら繰り返す。
 * ターンは会話ごとに直列。ターンの最中に新しい発言が来たら、LLM の出力を待っていればその呼び出しを打ち切り、
 * ツールの実行中ならツールが終わってから打ち切って、次のターンで読む。
 * 会話にジョブが走っていれば、発言を受けてから会話のターンが全部終わるまで、ジョブの LLM の段を待たせる。
 */
export class TalkRunner {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly running = new Set<string>();
  private readonly active = new Map<string, ActiveTurn>();
  /** 会話ごとに待たせているジョブ。ターンが全部終わったら必ず解く */
  private readonly holds = new Map<string, { jobId: string; release: () => void }>();
  private readonly holdOps = new Map<string, Promise<void>>();
  /** 会話ごとの、話しかけるのを待っている止まったジョブ */
  private readonly stoppedJobs = new Map<string, string>();
  private readonly now: () => Date;
  private readonly newCallId: (now: Date) => string;
  private readonly window: TalkWindowReader;
  /** 最後に読んだ設定の、直近の発言の件数 */
  private recentMessages = DEFAULT_TALK_LIMITS.recentMessages;
  private seq = 0;

  constructor(private readonly deps: TalkRunnerDeps) {
    this.window = new TalkWindowReader(deps.store);
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
      void this.noticeNewMessage(conversationId);
    }
    this.schedule(conversationId);
  }

  /**
   * 会話のジョブが止まったことを受ける。AI の判断・上限・エラーで止まったなら、話す役のターンを1回起こして結果を伝えさせる。
   * 走っているターンは打ち切らず、終わってから起こす。そのときに未読の発言があれば、同じターンで読む。
   */
  // 再起動では起こし直さない（落ちる前の止まりは、ここに知らされない）: 途切れたターンを自動でやり直さないのと同じ考え（設計の推奨 8）
  reportJobStopped(stop: StoppedJob): void {
    if (!speaksAfterJobStop(stop.reason)) return;
    this.stoppedJobs.set(stop.conversationId, stop.jobId);
    this.schedule(stop.conversationId);
  }

  private schedule(conversationId: string): void {
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

  /**
   * 人間の中断。走っているターンを打ち切る（LLM の出力を待っていればその呼び出しを abort、ツールの実行中ならツールが終わってから）。
   * scope が all なら、会話のジョブも止める。走っているものが無ければ何もしない。
   */
  async interrupt(
    conversationId: string,
    scope: 'turn' | 'all',
  ): Promise<{ turn: boolean; job: string | undefined }> {
    const turn = this.active.get(conversationId);
    if (turn !== undefined) this.requestInterrupt(turn);
    if (scope === 'turn') return { turn: turn !== undefined, job: undefined };
    // ツールの実行中なら、ツールが作るジョブも止めるため、ターンが終わってから探す
    if (turn?.phase === 'tool') await turn.done;
    const jobs = this.deps.jobs;
    const job = await jobs?.active(conversationId);
    if (job !== undefined) await jobs?.stop(job);
    return { turn: turn !== undefined, job };
  }

  private requestInterrupt(turn: ActiveTurn): void {
    turn.interrupting = true;
    turn.llm?.abort();
  }

  /** 走っているターンがまだ読んでいない発言が来ていたら、そのターンを打ち切り、ジョブの LLM の段を待たせる */
  private async noticeNewMessage(conversationId: string): Promise<void> {
    try {
      const turn = this.active.get(conversationId);
      if (turn?.readSeqs === undefined) return;
      const fresh = (await this.window.read(conversationId, 0)).unread.length > 0;
      // 読んでいる間にターンが替わっていたら、新しいターンが読むので何もしない
      if (!fresh || turn.finished || this.active.get(conversationId) !== turn) return;
      this.requestInterrupt(turn);
      await this.ensureHold(conversationId);
    } catch (error) {
      this.deps.log?.(
        `drawroid: 会話 ${conversationId} の発言を割り込みにできなかった: ${String(error)}`,
      );
    }
  }

  /** 会話のジョブの LLM の段を、ターンが終わるまで待たせる。同じジョブには重ねない */
  private ensureHold(conversationId: string): Promise<void> {
    const jobs = this.deps.jobs;
    if (jobs === undefined) return Promise.resolve();
    const op = (this.holdOps.get(conversationId) ?? Promise.resolve()).then(async () => {
      const jobId = await jobs.active(conversationId);
      const held = this.holds.get(conversationId);
      if (jobId === held?.jobId) return;
      // 新しく待たせてから古いほうを解く: 解けた瞬間に段が動き出さないように
      const next = jobId === undefined ? undefined : { jobId, release: jobs.hold(jobId) };
      held?.release();
      if (next === undefined) this.holds.delete(conversationId);
      else this.holds.set(conversationId, next);
    });
    const safe = op.catch((error: unknown) => {
      this.deps.log?.(
        `drawroid: 会話 ${conversationId} のジョブを待たせられなかった: ${String(error)}`,
      );
    });
    this.holdOps.set(conversationId, safe);
    return safe;
  }

  private async releaseHold(conversationId: string): Promise<void> {
    await this.holdOps.get(conversationId);
    this.holds.get(conversationId)?.release();
    this.holds.delete(conversationId);
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
      // 成功・失敗・打ち切りのどれでも解く
      await this.releaseHold(conversationId);
      this.running.delete(conversationId);
    }
  }

  /** 話しかけるのを待っている止まったジョブを取り出す。もう話しかけた・新しいジョブに替わったなら undefined */
  private async takeStoppedJob(conversationId: string): Promise<string | undefined> {
    const jobId = this.stoppedJobs.get(conversationId);
    if (jobId === undefined) return undefined;
    this.stoppedJobs.delete(conversationId);
    return (await this.stillToReport(conversationId, jobId)) ? jobId : undefined;
  }

  /**
   * 会話の末尾から、そのジョブの job.stopped まで遡って、話しかけてよいかを見る。job.stopped より後に、そのジョブで起こした
   * ターンがあれば、もう話しかけた。別のジョブが始まっていれば、そのジョブの話に、古いジョブの報告を割り込ませない
   */
  // 頭から全部は読まない: そのジョブで起こすターンも、替わったジョブも、job.stopped より後にしか無いので、そこまでで足りる
  private async stillToReport(conversationId: string, jobId: string): Promise<boolean> {
    let before: number | undefined;
    for (;;) {
      const page = await this.deps.store.readEventsBefore(conversationId, {
        ...(before === undefined ? {} : { before }),
        limit: STOP_SCAN_PAGE,
      });
      for (const event of page.toReversed()) {
        if (event.type === 'job.started' && event.jobId !== jobId) return false;
        if (event.type === 'job.stopped' && event.jobId === jobId) return true;
      }
      if (page.length < STOP_SCAN_PAGE) return false;
      before = page[0]!.seq;
    }
  }

  /** 未読の発言か、話しかけるのを待っている止まったジョブがあれば、ターンを1つ回す。回したら true */
  private async runTurn(conversationId: string): Promise<boolean> {
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    const state: ActiveTurn = {
      readSeqs: undefined,
      interrupting: false,
      llm: undefined,
      phase: 'other',
      finished: false,
      done,
      finish: () => {
        state.finished = true;
        finish();
      },
    };
    this.active.set(conversationId, state);
    try {
      return await this.runTurnBody(conversationId, state);
    } finally {
      if (this.active.get(conversationId) === state) this.active.delete(conversationId);
      state.finish();
    }
  }

  private async runTurnBody(conversationId: string, state: ActiveTurn): Promise<boolean> {
    const hub = this.deps.hubs.get(conversationId);
    // 会話の末尾から、要る分だけ読む（頭から全部は読まない）。直近の発言の件数は、最後に分かっている設定で読み、
    // 設定を読んでから足りなければ読み足す（読む前に設定を待たない: 発言を受けてからターンを始めるまでを延ばさないため）
    const window = await this.window.read(conversationId, this.recentMessages);
    const { unread, nextTurn: turn } = window;
    const jobId = await this.takeStoppedJob(conversationId);
    if (unread.length === 0 && jobId === undefined) return false;
    await hub.confirm({
      type: 'turn.started',
      turn,
      messageSeqs: unread,
      ...(jobId !== undefined && { jobId }),
    });
    const end: TurnEnd = (outcome, reason) =>
      hub.confirm({
        type: 'turn.ended',
        turn,
        outcome,
        ...(reason === undefined ? {} : { reason }),
      });
    // 始めたターンは、どの抜け方でも閉じる: 閉じないと、ターンが開いたまま残り、次のターンが重なって始まる。
    // 会話の一覧と起動時の復帰は、ターンが1つずつ閉じる前提で末尾だけを読むので、走っているかを取り違える
    try {
      return await this.runStartedTurn(conversationId, state, window, end, jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await end('error', `ターンが失敗した: ${message}`);
      return true;
    }
  }

  /** turn.started を確定したあとのターンの本体。閉じる turn.ended は、終わり方ごとに end で書く */
  private async runStartedTurn(
    conversationId: string,
    state: ActiveTurn,
    window: TalkWindow,
    end: TurnEnd,
    /** 止まったことを受けて起こしたなら、そのジョブ */
    stoppedJob: string | undefined,
  ): Promise<boolean> {
    const hub = this.deps.hubs.get(conversationId);
    const { unread, nextTurn: turn } = window;
    // 人間の発言の無い、止まりを伝えるだけのターンには、ツールを渡さず1ステップで返答させる: 描き直すツールを呼べると、
    // 描く → 止まる → 話しかける → また描く、が人間抜きで続きうるため。トークンも1回ぶんで済む
    const reportOnly = unread.length === 0;
    state.readSeqs = new Set(unread);
    // 発言を受けたら、ターンが全部終わるまでジョブの LLM の段を待たせる
    await this.ensureHold(conversationId);
    // turn.started を確定する前に届いた発言も、打ち切りにする
    void this.noticeNewMessage(conversationId);

    const llm = this.deps.llm();
    if (llm === undefined) {
      await end('error', LLM_NOT_CONFIGURED_REASON);
      return true;
    }
    const limits = await this.deps.limits();
    this.recentMessages = limits.recentMessages;
    const { events, oldest } = await this.window.widen(
      conversationId,
      window,
      limits.recentMessages,
    );
    const job = await this.deps.jobSummary?.(events);
    const info = llm.describe('talk');
    // ツールには打ち切りを伝えない: 実行中のツールは最後まで走らせる（途中で止めると、ジョブが半分だけできる）
    const toolSignal = new AbortController().signal;
    const steps: TalkStepRecord[] = [];
    // このターンで走らせたツールの呼び出し（名前と引数）。同じ呼び出しを2度は走らせない
    const called = new Set<string>();
    let repeated = false;
    try {
      for (let step = 0; step < limits.maxSteps; step += 1) {
        // 同じ呼び出しを繰り返したら、次のステップはツールを渡さず返答させる: 小さいモデルが同じツールを呼び続けて、
        // 上限まで同じことを走らせ（副作用のあるツールなら何度も効かせ）ないように
        const final = reportOnly || step === limits.maxSteps - 1 || repeated;
        const messages = buildTalkInput({
          events,
          earlierMessages: oldest !== undefined,
          messageSeqs: unread,
          ...(job === undefined ? {} : { job }),
          steps,
          final,
          jobStopped: stoppedJob !== undefined,
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
        if (state.interrupting) {
          await end('interrupted', INTERRUPTED_REASON);
          return true;
        }
        const startedAt = this.now();
        hub.live({ type: 'status', status: 'waiting-llm' });
        const controller = new AbortController();
        state.llm = controller;
        state.phase = 'llm';
        try {
          for await (const part of llm.streamStep({
            role: 'talk',
            messages,
            tools: final ? [] : this.deps.tools,
            signal: controller.signal,
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
        } catch (error) {
          // 打ち切りのための abort でなければ、ターンの失敗として投げる
          if (!controller.signal.aborted) throw error;
        } finally {
          state.llm = undefined;
          state.phase = 'other';
        }
        const aborted = controller.signal.aborted;
        // 前後の空行は返答に含めない: 思考のあとの改行だけが残った応答を、空の返答として扱うため
        text = text.trim();
        const value: StepValue = {
          text,
          toolCalls: toolCalls.map(({ name, input }) => ({ name, input })),
        };
        if (aborted) failure ??= INTERRUPTED_REASON;
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
          // 打ち切ったときは、流れていた本文を、途中で止まった印つきで確定する
          await hub.confirm({
            type: 'assistant.message',
            turn,
            partId: textPart,
            text,
            ...(aborted && { interrupted: true }),
          });
        }
        if (aborted) {
          await end('interrupted', INTERRUPTED_REASON);
          return true;
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
          // 引数はツールのスキーマで読み直してあり、鍵の順はスキーマの順にそろっている
          const key = `${call.name}:${JSON.stringify(call.input)}`;
          state.phase = 'tool';
          try {
            if (tool === undefined) throw new Error(`知らないツール ${call.name}`);
            if (called.has(key)) {
              repeated = true;
              throw new Error(REPEATED_TOOL_CALL_REASON);
            }
            called.add(key);
            result = await tool.run(call.input, {
              conversationId,
              turn,
              events,
              limits,
              signal: toolSignal,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result = {
              ok: false,
              result: `${TOOL_THREW_PREFIX}${message}`,
              summary: `${TOOL_THREW_PREFIX}${message}`,
            };
          }
          state.phase = 'other';
          await hub.confirm({
            type: 'tool.result',
            turn,
            callId: call.callId,
            ok: result.ok,
            summary: result.summary,
          });
          // ツールが終わって結果が確定してから打ち切る。残りのツールは呼ばない
          if (state.interrupting) {
            await end('interrupted', INTERRUPTED_REASON);
            return true;
          }
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
