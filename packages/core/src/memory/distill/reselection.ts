import { resolveBudgets } from '../../budget/settings.js';
import type { JobStore } from '../../job/store.js';
import type { LlmPort } from '../../llm/port.js';
import { toLlmCallRecord } from '../../llm/record.js';
import { createCarry } from '../../loop/carry.js';
import { defaultCallId } from '../../loop/runner.js';
import { summarizeSelections } from '../../selection/selection.js';
import type { MemoryStore } from '../store.js';
import type { DistillLog } from './log.js';
import { distillReselection } from './run.js';

export type ReselectionTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type ReselectionDistillerDeps = {
  store: JobStore;
  memory: MemoryStore;
  log: DistillLog;
  /** 呼ぶたびに今の LLM を引く。未設定なら何もしない */
  llm: () => LlmPort | undefined;
  /** この間に次の知らせが来なければ走らせる */
  quietMs?: number;
  now?: () => Date;
  newCallId?: (now: Date) => string;
  timers?: ReselectionTimers;
  onError?: (error: unknown) => void;
};

export const DEFAULT_RESELECTION_QUIET_MS = 5000;

type Slot = { timer?: unknown; running?: Promise<void>; again: boolean };

/**
 * 止まったジョブで選択が変わったときの、小さな蒸留を裏で回す。ジョブごとに直列で、短い間の知らせは1回にまとめる。
 */
// 選択の口の応答の中で蒸留しない: LLM を待つ間、人間の操作が止まるため
export class ReselectionDistiller {
  private readonly slots = new Map<string, Slot>();
  private readonly quietMs: number;
  private readonly now: () => Date;
  private readonly newCallId: (now: Date) => string;
  private readonly timers: ReselectionTimers;

  constructor(private readonly deps: ReselectionDistillerDeps) {
    this.quietMs = deps.quietMs ?? DEFAULT_RESELECTION_QUIET_MS;
    this.now = deps.now ?? (() => new Date());
    this.newCallId = deps.newCallId ?? defaultCallId;
    this.timers = deps.timers ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
  }

  /** 選択が変わった知らせ。待ちを数え直し、静かになったら1回走らせる */
  notify(jobId: string): void {
    const slot = this.slots.get(jobId) ?? { again: false };
    this.slots.set(jobId, slot);
    if (slot.running !== undefined) {
      slot.again = true;
      return;
    }
    if (slot.timer !== undefined) this.timers.clearTimeout(slot.timer);
    slot.timer = this.timers.setTimeout(() => this.start(jobId, slot), this.quietMs);
  }

  /** 待ちと走っているものを、全部走らせ切るまで待つ。待ちは捨てない */
  async idle(): Promise<void> {
    while (this.slots.size > 0) {
      const running: Promise<void>[] = [];
      for (const [jobId, slot] of this.slots) {
        if (slot.timer !== undefined) {
          this.timers.clearTimeout(slot.timer);
          this.start(jobId, slot);
        }
        if (slot.running !== undefined) running.push(slot.running);
      }
      await Promise.all(running);
    }
  }

  private start(jobId: string, slot: Slot): void {
    slot.timer = undefined;
    slot.running = this.drain(jobId, slot);
  }

  private async drain(jobId: string, slot: Slot): Promise<void> {
    do {
      slot.again = false;
      try {
        await this.distillOnce(jobId);
      } catch (error) {
        this.deps.onError?.(error);
      }
    } while (slot.again);
    slot.running = undefined;
    if (slot.timer === undefined) this.slots.delete(jobId);
  }

  private async distillOnce(jobId: string): Promise<void> {
    const { store, memory, log } = this.deps;
    const llm = this.deps.llm();
    if (llm === undefined) return;
    const spec = await store.readJob(jobId);
    if (spec.kind !== 'auto') return;
    const state = await store.readState(jobId);
    if (state.status !== 'stopped') return;

    // 境目は、失敗しなかった最後の蒸留の時刻: 失敗した回は何も覚えていないので、その回に渡した選び直しを、
    // 次の蒸留でもう一度渡す（失敗の記録は残すが、境目は進めない）
    const lastDistilledAt = (await log.read(jobId)).findLast(
      (entry) => entry.failure === undefined,
    )?.at;
    const since = Math.max(
      Date.parse(state.stoppedAt),
      lastDistilledAt === undefined ? 0 : Date.parse(lastDistilledAt),
    );
    // 選択を読む直前の時刻を、この蒸留の時刻として残す: 蒸留を始めた時刻にすると、読んでから始めるまでの間に
    // 選び直された分が、その時刻より前になり、次の蒸留でも見られないまま取りこぼされるため
    const readAt = this.now();
    const changedKeys = new Set(
      (await store.listSelections(jobId))
        .filter((record) => Date.parse(record.selectedAt) > since)
        .map((record) => record.imageKey),
    );
    if (changedKeys.size === 0) return;
    const changes = (await summarizeSelections(store, jobId)).filter((summary) =>
      changedKeys.has(summary.imageKey),
    );

    const budgets = resolveBudgets(spec.budgets ?? {});
    const startedAt = this.now();
    const callId = this.newCallId(startedAt);
    const { provider, model, window } = llm.describe('think');
    const result = await distillReselection(
      {
        llm,
        memory,
        log,
        window,
        budget: budgets.distill,
        now: this.now,
        callId,
        startedAt: readAt,
      },
      {
        jobId,
        intent: state.carry?.intent ?? createCarry(spec.request, budgets).carry.intent,
        changes,
      },
    );
    if (result?.call === undefined) return;
    await store.writeLlmCall(
      toLlmCallRecord({
        callId,
        jobId,
        iteration: null,
        role: 'think',
        purpose: 'distill',
        provider,
        model,
        startedAt,
        messages: result.call.messages,
        outcome: result.call.outcome,
      }),
    );
  }
}
