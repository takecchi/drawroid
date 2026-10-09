import type { ZodType } from 'zod';

import { generationRequestSchema, type GenerationRequest, type ImageBackend } from '../backend.js';
import { BackendError } from '../backend-error.js';
import type { ImageRef, JobStore } from '../job/store.js';
import type { AutoJobSpec, JobState, StopReason } from '../job/types.js';
import type {
  BudgetedMessages,
  LlmCallOutcome,
  LlmPort,
  LlmPurpose,
  LlmRole,
} from '../llm/port.js';
import { toLlmCallRecord } from '../llm/record.js';
import type { Budget } from './budget.js';
import { advanceCarry, createCarry, type Carry } from './carry.js';
import { buildJudgeInput, buildThinkInput } from './inputs.js';
import {
  buildJudgeOutputSchema,
  buildThinkOutputSchema,
  type JudgeOutput,
  type ThinkOutput,
  type ThinkParamKey,
} from './schemas.js';
import { checkStopAtBoundary } from './stop.js';

/** AI に任せていないパラメータの値（M2 では解像度など） */
export type GenerationDefaults = {
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  negativePrompt: string;
};

export type JobRunnerDeps = {
  store: JobStore;
  llm: LlmPort;
  backend: ImageBackend;
  budget: Budget;
  /** 考える役が決めてよいパラメータ */
  allowed: readonly ThinkParamKey[];
  defaults: GenerationDefaults;
  now?: () => Date;
  /** LLM 呼び出しの ID。名前の順が呼び出しの順になる形にする */
  newCallId?: (now: Date) => string;
};

type Running = { jobId: string; controller: AbortController };
type RunningState = Extract<JobState, { status: 'running' }> & { carry: Carry };

/** ループを止めて、理由を state.json に残すための合図 */
class StopJob extends Error {
  constructor(readonly reason: StopReason) {
    super(reason.detail);
    this.name = 'StopJob';
  }
}

const HUMAN_STOP: StopReason = { kind: 'human', detail: '人間が止めた' };

export function defaultCallId(now: Date): string {
  return `${now.toISOString().replaceAll(/[-:.]/g, '')}-${crypto.randomUUID().slice(0, 6)}`;
}

/**
 * ジョブを待ち行列の順に1つずつ回す。人間を待たずに、止める条件に当たるまで回る。
 */
export class JobRunner {
  private readonly now: () => Date;
  private readonly newCallId: (now: Date) => string;
  private running: Running | undefined;
  private draining: Promise<void> | undefined;

  constructor(private readonly deps: JobRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newCallId = deps.newCallId ?? defaultCallId;
  }

  /** 待ち行列を回し始める。回っている間に呼んでもよい */
  kick(): void {
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
  }

  /** 待ち行列が空になるまで待つ */
  async idle(): Promise<void> {
    while (this.draining !== undefined) await this.draining;
  }

  /** 人間の停止。走っているジョブは段の途中でも止め、待っているジョブはそのまま止める */
  async stop(jobId: string): Promise<void> {
    if (this.running?.jobId === jobId) {
      this.running.controller.abort();
      // signal の abort は HTTP の待ちを切るだけで、GPU は回り続けるため、バックエンドにも止めさせる
      await this.deps.backend.interrupt();
      return;
    }
    const state = await this.deps.store.readState(jobId);
    if (state.status === 'stopped') return;
    await this.deps.store.writeState(jobId, this.stopped(state, HUMAN_STOP));
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = await this.nextJobId();
      if (next === undefined) return;
      await this.runJob(next);
    }
  }

  /** 走りかけのジョブ（落ちる前に running だったもの）を先に、次に待っているものを作成順に */
  private async nextJobId(): Promise<string | undefined> {
    let queued: string | undefined;
    for (const jobId of await this.deps.store.listJobIds()) {
      const spec = await this.deps.store.readJob(jobId);
      if (spec.kind !== 'auto') continue;
      const { status } = await this.deps.store.readState(jobId);
      if (status === 'running') return jobId;
      if (status === 'queued') queued ??= jobId;
    }
    return queued;
  }

  private async runJob(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.running = { jobId, controller };
    const { store } = this.deps;
    let state = await store.readState(jobId);
    try {
      const spec = await store.readJob(jobId);
      if (spec.kind !== 'auto' || state.status === 'stopped') return;
      let running: RunningState;
      if (state.status === 'queued') {
        running = {
          status: 'running',
          // 走る前の要約は依頼だけから決まるので、無ければここで作る
          carry: state.carry ?? createCarry(spec.request, this.deps.budget).carry,
          startedAt: this.now().toISOString(),
          imagesGenerated: 0,
        };
        state = running;
        await store.writeState(jobId, running);
      } else if (state.carry === undefined) {
        throw new StopJob({ kind: 'error', detail: 'state.json に持ち回しの要約（carry）が無い' });
      } else {
        running = { ...state, carry: state.carry };
      }
      await this.loop(spec, running, controller.signal);
    } catch (error) {
      const current = await store.readState(jobId);
      if (current.status === 'stopped') return;
      const reason = controller.signal.aborted
        ? HUMAN_STOP
        : error instanceof StopJob
          ? error.reason
          : { kind: 'error' as const, detail: `予期しない失敗: ${messageOf(error)}` };
      await store.writeState(jobId, this.stopped(current, reason));
    } finally {
      this.running = undefined;
    }
  }

  private async loop(spec: AutoJobSpec, initial: RunningState, signal: AbortSignal): Promise<void> {
    const { store } = this.deps;
    let state = initial;
    for (;;) {
      signal.throwIfAborted();
      const stop = await this.checkBoundary(spec, state);
      if (stop !== undefined) throw new StopJob(stop);

      const iteration = state.carry.completedIterations + 1;
      const think = await this.think(spec, state.carry, iteration, signal);
      const imageCount = await this.generate(spec, iteration, think, signal);
      const judge = await this.judge(spec, state.carry, iteration, imageCount, signal);

      state = {
        ...state,
        carry: advanceCarry(state.carry, iteration, think.params, judge),
        imagesGenerated: state.imagesGenerated + imageCount,
      };
      await store.writeState(spec.jobId, state);
    }
  }

  private async checkBoundary(
    spec: AutoJobSpec,
    state: RunningState,
  ): Promise<StopReason | undefined> {
    const done = state.carry.completedIterations;
    const lastJudge =
      done === 0
        ? undefined
        : ((await this.deps.store.readStage(spec.jobId, done, 'judge')) as JudgeOutput | undefined);
    return checkStopAtBoundary({
      conditions: spec.stopConditions,
      completedIterations: done,
      imagesGenerated: state.imagesGenerated,
      elapsedMs: this.now().getTime() - Date.parse(state.startedAt),
      judgeSaysStop: lastJudge?.canStop ?? false,
    });
  }

  private async think(
    spec: AutoJobSpec,
    carry: Carry,
    iteration: number,
    signal: AbortSignal,
  ): Promise<ThinkOutput> {
    const { store, llm, budget, allowed } = this.deps;
    const done = await store.readStage(spec.jobId, iteration, 'think');
    if (done !== undefined) return done as ThinkOutput;

    const max = spec.stopConditions.maxIterations;
    const messages = buildThinkInput({
      carry,
      progress: {
        iteration,
        ...(max === undefined ? {} : { remainingIterations: max - iteration + 1 }),
      },
      allowed,
      budget,
      window: llm.describe('think').window,
    });
    const outcome = await this.callLlm(spec.jobId, iteration, 'think', 'think', messages, {
      schema: buildThinkOutputSchema(allowed, budget),
      signal,
    });
    if (!outcome.ok) throw new StopJob({ kind: 'error', detail: `考える段: ${outcome.reason}` });
    await store.writeStage(spec.jobId, iteration, 'think', outcome.value);
    return outcome.value;
  }

  /** 生成して画像と request.json を置く。済んでいれば置いた枚数だけを返す */
  private async generate(
    spec: AutoJobSpec,
    iteration: number,
    think: ThinkOutput,
    signal: AbortSignal,
  ): Promise<number> {
    const { store, backend } = this.deps;
    const done = await store.readGeneration(spec.jobId, iteration);
    if (done !== undefined) return done.images.length;

    const request = this.toRequest(spec, think);
    let result;
    try {
      result = await backend.generate(request, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new StopJob({
        kind: 'error',
        detail: `生成の段: ${messageOf(error)}`,
        ...(error instanceof BackendError ? { backendErrorKind: error.kind } : {}),
      });
    }
    signal.throwIfAborted();
    await store.writeGeneration(
      spec.jobId,
      iteration,
      { ...request, batchSize: result.images.length },
      result,
    );
    return result.images.length;
  }

  private toRequest(spec: AutoJobSpec, think: ThinkOutput): GenerationRequest {
    const { defaults } = this.deps;
    const p = think.params;
    return generationRequestSchema.parse({
      prompt: p.prompt ?? '',
      negativePrompt: p.negativePrompt ?? defaults.negativePrompt,
      steps: p.steps ?? defaults.steps,
      cfgScale: p.cfg ?? defaults.cfgScale,
      ...(p.seed === undefined || p.seed < 0 ? {} : { seed: p.seed }),
      width: defaults.width,
      height: defaults.height,
      batchSize: spec.batchSize,
    });
  }

  private async judge(
    spec: AutoJobSpec,
    carry: Carry,
    iteration: number,
    imageCount: number,
    signal: AbortSignal,
  ): Promise<JudgeOutput> {
    const { store, llm, budget } = this.deps;
    const done = await store.readStage(spec.jobId, iteration, 'judge');
    if (done !== undefined) return done as JudgeOutput;

    const refs: ImageRef[] = Array.from({ length: imageCount }, (_, index) => ({
      jobId: spec.jobId,
      iteration,
      index,
    }));
    const previews = [];
    for (const ref of refs) previews.push(await store.loadPreview(ref, budget.imageLongEdge));
    const messages = buildJudgeInput({
      carry,
      images: previews,
      budget,
      window: llm.describe('judge').window,
    });
    const outcome = await this.callLlm(spec.jobId, iteration, 'judge', 'judge', messages, {
      schema: buildJudgeOutputSchema(imageCount, budget),
      signal,
      sentImages: refs,
    });
    if (!outcome.ok) throw new StopJob({ kind: 'error', detail: `見る段: ${outcome.reason}` });
    await store.writeStage(spec.jobId, iteration, 'judge', outcome.value);
    return outcome.value;
  }

  /**
   * LLM を呼び、記録を置き、渡した画像に印を付ける。中断のときは記録を置かずに投げる。
   */
  // 印は呼び出しのあとに付ける: 先に付けると、呼び出しの途中で落ちたときに、再開した回が
  // 「渡し済み」の画像を渡せず進めなくなるため。そのかわり、呼び出しが返ってから印を付けるまでの
  // 間に落ちると、再開で同じ画像をもう1度渡す
  private async callLlm<T>(
    jobId: string,
    iteration: number,
    role: LlmRole,
    purpose: LlmPurpose,
    messages: BudgetedMessages,
    options: { schema: ZodType<T>; signal: AbortSignal; sentImages?: ImageRef[] },
  ): Promise<LlmCallOutcome<T>> {
    const startedAt = this.now();
    const outcome = await this.deps.llm.generateStructured({
      role,
      purpose,
      schema: options.schema,
      messages,
      signal: options.signal,
    });
    const callId = this.newCallId(startedAt);
    const { provider, model } = this.deps.llm.describe(role);
    await this.deps.store.writeLlmCall(
      toLlmCallRecord({
        callId,
        jobId,
        iteration,
        role,
        purpose,
        provider,
        model,
        startedAt,
        messages,
        outcome,
      }),
    );
    for (const ref of options.sentImages ?? [])
      await this.deps.store.markSent(ref, callId, this.now());
    return outcome;
  }

  private stopped(state: JobState, reason: StopReason): JobState {
    return {
      status: 'stopped',
      ...(state.carry === undefined ? {} : { carry: state.carry }),
      ...(state.status === 'running' ? { startedAt: state.startedAt } : {}),
      stoppedAt: this.now().toISOString(),
      imagesGenerated: state.status === 'queued' ? 0 : state.imagesGenerated,
      reason,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
