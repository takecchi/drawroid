import type { ZodType } from 'zod';

import type { GenerationRequest, ImageBackend } from '../backend.js';
import { BackendError } from '../backend-error.js';
import type { AnyImageRef, ImageRef, JobStore, ReferenceImageRef } from '../job/store.js';
import {
  stopConditionsChangeSchema,
  type AutoJobSpec,
  type InterventionRecord,
  type JobState,
  type NewReference,
  type ReferenceRecord,
  type StopConditions,
  type StopConditionsChange,
  type StopReason,
} from '../job/types.js';
import type {
  BudgetedMessages,
  LlmCallOutcome,
  LlmPort,
  LlmPurpose,
  LlmRole,
} from '../llm/port.js';
import { toLlmCallRecord } from '../llm/record.js';
import type { MemoryItem } from '../memory/item.js';
import type { MemoryLimits } from '../memory/limits.js';
import { DEFAULT_DISTILL_BUDGET, type DistillBudget } from '../memory/distill/budget.js';
import type { StoppedJobMaterial } from '../memory/distill/input.js';
import type { DistillLog } from '../memory/distill/log.js';
import { distillStoppedJob } from '../memory/distill/run.js';
import type { MemoryStore } from '../memory/store.js';
import { summarizeSelections } from '../selection/selection.js';
import { applyIntegratedIntent } from '../intervention/integrate.js';
import type { InterventionLimits } from '../intervention/intervention.js';
import { planInterventions } from '../intervention/plan.js';
import {
  buildRefGistOutputSchema,
  carriedReferences,
  referencesWithoutGist,
  type ReferenceLimits,
} from '../reference/reference.js';
import { DEFAULT_BUDGETS, resolveBudgets, type Budgets } from '../budget/settings.js';
import type { Budget } from './budget.js';
import { advanceCarry, createCarry, type Carry } from './carry.js';
import { buildJudgeInput, buildRefGistInput, buildThinkInput, type MemoryInput } from './inputs.js';
import {
  buildJudgeOutputSchema,
  buildThinkOutputSchema,
  type JudgeOutput,
  type ThinkOutput,
} from './schemas.js';
import {
  checkStopAtBoundary,
  effectiveStopConditions,
  hasAnyStopCondition,
  readStopConditions,
} from './stop.js';
import type { BackendCapabilities, Candidate, CandidateKind } from '../backend.js';
import type { PackLimits } from '../budget/pack.js';
import type { ParamKey } from '../params/param-key.js';
import { toGenerationRequest } from '../permissions/generation-request.js';
import {
  type EffectivePermissions,
  effectivePermissions,
  mergePermissions,
  type Permissions,
} from '../permissions/permission.js';
import { excludedOf } from '../think/excluded.js';
import { buildParamsSchema, type ParamsSchema } from '../think/params-schema.js';
import type { ShownCandidates } from './inputs.js';
import type { InputImageRef } from '../backend.js';
import type { MaskIntervention, NewMask } from '../job/types.js';
import {
  activeMask,
  generatedImageRef,
  imageSourcesOf,
  type ImageSourceKey,
  loadRequestImages,
  maskImageRef,
  parseInputImageRef,
} from './image-sources.js';
import {
  type CandidateNotes,
  candidateKindsToList,
  shownCandidatesFor,
} from './iteration-permissions.js';

/** 記憶の置き場所と、止まったジョブから好みを学んだ記録の置き場所 */
export type JobMemory = {
  /** 回の境目ごとに読み直す。人間が直したら次の回から効く */
  store: MemoryStore;
  distillLog: DistillLog;
  /** 役ごとの記憶の予算。job.json に budgets が無い古いジョブの既定。省けば既定値 */
  limits?: MemoryLimits;
  distillBudget?: DistillBudget;
};

export type JobRunnerDeps = {
  store: JobStore;
  llm: LlmPort;
  backend: ImageBackend;
  /** job.json に budgets が無い古いジョブのための既定。新しいジョブは投入のときの値で回る */
  budget: Budget;
  /**
   * 全体の既定の許可。ジョブごとの上書き（job.json の permissions）を重ねて使う。
   * 読む関数を渡せば、回の境目ごとに読み直し、走行中のジョブにも次の回から効く
   */
  permissions: Permissions | (() => Promise<Permissions>);
  /** 候補の種類ごとに、考える役へ見せる候補の件数と文字数。省けば既定値 */
  candidateLimits?: PackLimits;
  /** 人間が候補に付けた短い説明を読む。ジョブの始めに1回呼ぶ。省けば説明なし */
  candidateNotes?: () => Promise<CandidateNotes>;
  /** 1回の「考える」に載せる人間の指示の上限。省けば既定値 */
  interventionLimits?: InterventionLimits;
  /** 持ち回す参照画像の要点の上限。省けば既定値 */
  referenceLimits?: ReferenceLimits;
  /** 省けば、記憶を渡さず、止まったときの蒸留もしない */
  memory?: JobMemory;
  /** 蒸留が投げて失敗したときの理由の行き先。ジョブの止まった状態には触れない */
  log?: (line: string) => void;
  now?: () => Date;
  /** LLM 呼び出しの ID。名前の順が呼び出しの順になる形にする */
  newCallId?: (now: Date) => string;
};

type Running = { jobId: string; controller: AbortController };
type BackendView = {
  capabilities: BackendCapabilities;
  lists: Partial<Record<CandidateKind, readonly Candidate[]>>;
  notes: CandidateNotes;
};
type ParamsPlan = {
  permissions: Permissions;
  /** 使えないものを落とす前の許可（人間が決めたもの） */
  merged: Permissions;
  disabled: EffectivePermissions['disabled'];
  candidates: ShownCandidates;
  /** 元画像に選べる画像（img2img を AI に任せる回だけ） */
  sources: { key: ImageSourceKey; ref: InputImageRef }[];
  /** inpaint に使えるマスク */
  mask: MaskIntervention | undefined;
  params: ParamsSchema;
};
type RunningState = Extract<JobState, { status: 'running' }> & { carry: Carry };

/** ループを止めて、理由を state.json に残すための合図 */
class StopJob extends Error {
  constructor(readonly reason: StopReason) {
    super(reason.detail);
    this.name = 'StopJob';
  }
}

const HUMAN_STOP: StopReason = { kind: 'human', detail: '人間が止めた' };

/** 口出しを断った理由。manual は口出しを受けない手動のジョブ、unstoppable は重ねると止まらなくなる変更 */
export type InterventionRejection = 'manual' | 'stopped' | 'unstoppable';

const REJECTION_MESSAGES: Record<InterventionRejection, string> = {
  manual: '口出しを受けない手動のジョブ',
  stopped: 'もう止まっている',
  unstoppable: '重ねると AI の判断も上限も無くなり、ジョブが止まらなくなる',
};

export class InterventionRejectedError extends Error {
  constructor(
    jobId: string,
    readonly reason: InterventionRejection,
  ) {
    super(`ジョブ ${jobId} への口出しは受けられない: ${REJECTION_MESSAGES[reason]}`);
    this.name = 'InterventionRejectedError';
  }
}

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
    const stopped = this.stopped(state, HUMAN_STOP);
    await this.deps.store.writeState(jobId, stopped);
    await this.distillAfterStop(jobId, stopped, HUMAN_STOP);
  }

  /**
   * 走行中・待ち行列のジョブの止める条件を変える。走っている段には触れず、次の回の境目から効く。
   * 変更を重ねたあとの、実際の止める条件を返す。
   */
  async changeStopConditions(jobId: string, change: StopConditionsChange): Promise<StopConditions> {
    const parsed = stopConditionsChangeSchema.parse(change);
    const spec = await this.acceptingJob(jobId);
    const changed = effectiveStopConditions(await this.stopConditions(spec), [parsed]);
    if (!hasAnyStopCondition(changed)) throw new InterventionRejectedError(jobId, 'unstoppable');
    await this.deps.store.addIntervention(
      jobId,
      { kind: 'stopConditions', stopConditions: parsed },
      this.now(),
    );
    return changed;
  }

  /** 走行中・待ち行列のジョブに人間の指示を置く。走っている段には触れず、次の回の「考える」から効く */
  async addInstruction(jobId: string, text: string): Promise<InterventionRecord> {
    await this.acceptingJob(jobId);
    return this.deps.store.addIntervention(jobId, { kind: 'instruction', text }, this.now());
  }

  /** 走行中・待ち行列のジョブに参照画像を添える。次の回の境目で、見る役が1度だけ見て要点にする */
  async addReference(jobId: string, reference: NewReference): Promise<ReferenceRecord> {
    await this.acceptingJob(jobId);
    return this.deps.store.addReference(jobId, reference, this.now());
  }

  /**
   * 走行中・待ち行列のジョブに inpaint のマスクを置く。次の回の境目から、inpaint が AI の選択肢に入る。
   * 塗った画像があるかは呼び手が確かめる。
   */
  async addMask(jobId: string, mask: NewMask): Promise<MaskIntervention> {
    await this.acceptingJob(jobId);
    return this.deps.store.addMask(jobId, mask, this.now());
  }

  /** 口出しを受けられる自動ジョブ（止まっていないもの）を返す */
  private async acceptingJob(jobId: string): Promise<AutoJobSpec> {
    const spec = await this.deps.store.readJob(jobId);
    if (spec.kind !== 'auto') throw new InterventionRejectedError(jobId, 'manual');
    if ((await this.deps.store.readState(jobId)).status === 'stopped') {
      throw new InterventionRejectedError(jobId, 'stopped');
    }
    return spec;
  }

  private stopConditions(spec: AutoJobSpec): Promise<StopConditions> {
    return readStopConditions(this.deps.store, spec);
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

  /**
   * そのジョブの予算。投入のときに job.json へ写した値を、ジョブが終わるまで使う。
   * budgets が無い古いジョブだけ、runner の既定で回る。
   */
  // 走行中に設定を読み直さない: 回を重ねても上限が一定であること（PRD:135・milestones:71）が崩れ、
  // 縮小版の長辺が途中で変わって同じ画像の縮小版が2つできるため
  private budgetsFor(spec: AutoJobSpec): Budgets {
    if (spec.budgets !== undefined) return resolveBudgets(spec.budgets);
    const { memory } = this.deps;
    return {
      ...this.deps.budget,
      candidates: this.deps.candidateLimits ?? DEFAULT_BUDGETS.candidates,
      interventions: this.deps.interventionLimits ?? DEFAULT_BUDGETS.interventions,
      references: this.deps.referenceLimits ?? DEFAULT_BUDGETS.references,
      memory: memory?.limits ?? DEFAULT_BUDGETS.memory,
      distill: memory?.distillBudget ?? DEFAULT_DISTILL_BUDGET,
    };
  }

  private async runJob(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.running = { jobId, controller };
    const { store } = this.deps;
    let state = await store.readState(jobId);
    let justStopped: { state: JobState; reason: StopReason } | undefined;
    try {
      const spec = await store.readJob(jobId);
      if (spec.kind !== 'auto' || state.status === 'stopped') return;
      let running: RunningState;
      if (state.status === 'queued') {
        running = {
          status: 'running',
          // 走る前の要約は依頼だけから決まるので、無ければここで作る
          carry: state.carry ?? createCarry(spec.request, this.budgetsFor(spec)).carry,
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
      const stopped = this.stopped(current, reason);
      await store.writeState(jobId, stopped);
      justStopped = { state: stopped, reason };
    } finally {
      this.running = undefined;
    }
    // 止まった状態を書いて、走行中の印を外したあとに行う: 人間の停止で中断した合図を蒸留に引きずらず、蒸留の失敗が止まった理由を変えないため
    if (justStopped !== undefined) {
      await this.distillAfterStop(jobId, justStopped.state, justStopped.reason);
    }
  }

  /**
   * 止まったジョブの口出し・選択から好みを学び、記憶に書く。止まった理由は書き換えず、失敗は log に残す。
   */
  // 学ぶ材料（口出しも選択も）が無ければ呼ばない: 学べないのに、ジョブごとに LLM 呼び出しの分のトークンを払うことになるため
  private async distillAfterStop(
    jobId: string,
    stopped: JobState,
    reason: StopReason,
  ): Promise<void> {
    const { memory, store } = this.deps;
    if (memory === undefined) return;
    try {
      const spec = await store.readJob(jobId);
      if (spec.kind !== 'auto') return;
      const material: StoppedJobMaterial = {
        jobId,
        intent:
          stopped.carry?.intent ?? createCarry(spec.request, this.budgetsFor(spec)).carry.intent,
        stopReason: { kind: reason.kind, detail: reason.detail },
        interventions: (await store.listInterventions(jobId))
          .flatMap((i) => (i.kind === 'instruction' ? [i] : []))
          .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
          .map((i) => ({ id: i.interventionId, text: i.text })),
        selections: await summarizeSelections(store, jobId),
      };
      const startedAt = this.now();
      const callId = this.newCallId(startedAt);
      const result = await distillStoppedJob(
        {
          llm: this.deps.llm,
          memory: memory.store,
          log: memory.distillLog,
          window: this.deps.llm.describe('think').window,
          budget: this.budgetsFor(spec).distill,
          now: this.now,
          callId,
        },
        material,
      );
      if (result.call === undefined) return;
      const { provider, model } = this.deps.llm.describe('think');
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
    } catch (error) {
      this.deps.log?.(`drawroid: ジョブ ${jobId} の蒸留に失敗した: ${messageOf(error)}`);
    }
  }

  /**
   * 役ごとの記憶の入力。回の境目ごとに読み直す。
   */
  // 読めないときは止める: 人間が直したはずの記憶が効かないまま、気づかずに回り続けるため（許可の読み直しと同じ扱い）
  private async readMemory(): Promise<readonly MemoryItem[] | undefined> {
    const { memory } = this.deps;
    if (memory === undefined) return undefined;
    try {
      return (await memory.store.list()).items;
    } catch (error) {
      throw new StopJob({ kind: 'error', detail: `記憶を読む段: ${messageOf(error)}` });
    }
  }

  private memoryInput(
    items: readonly MemoryItem[] | undefined,
    limits: MemoryLimits,
    role: 'think' | 'judge',
  ): { memory: MemoryInput } | Record<string, never> {
    if (items === undefined) return {};
    return { memory: { items, limits: limits[role] } };
  }

  /**
   * ジョブの間に使う、バックエンドの能力と候補の一覧。能力はジョブの始めに1回だけ取り、
   * 候補の一覧は、AI に任せた種類を初めて使う回に1回だけ取る。
   */
  // 回ごとに取り直さない: 候補の一覧（LoRA が数百個など）を毎回取るのは重く、ジョブの途中で変わることも稀なため。
  // 始めに全部を取りもしない: 全体の既定の許可が走行中に変わり、任せる種類が後から増えることがあるため
  private async viewBackend(
    spec: AutoJobSpec,
    defaults: Permissions,
    signal: AbortSignal,
  ): Promise<BackendView> {
    let capabilities: BackendCapabilities;
    try {
      capabilities = await this.deps.backend.probe(signal);
    } catch (error) {
      throw this.backendStageError(error, signal);
    }
    const view = { capabilities, lists: {}, notes: await this.readCandidateNotes() };
    await this.ensureCandidateLists(spec, view, defaults, signal);
    return view;
  }

  private async ensureCandidateLists(
    spec: AutoJobSpec,
    view: BackendView,
    defaults: Permissions,
    signal: AbortSignal,
  ): Promise<void> {
    const { permissions } = this.jobPermissions(spec, defaults, view.capabilities, false);
    try {
      for (const kind of candidateKindsToList(permissions)) {
        view.lists[kind] ??= await this.deps.backend.listCandidates(kind, signal);
      }
    } catch (error) {
      throw this.backendStageError(error, signal);
    }
  }

  private backendStageError(error: unknown, signal: AbortSignal): unknown {
    if (signal.aborted) return error;
    return new StopJob({
      kind: 'error',
      detail: `バックエンドの能力と候補を取る段: ${messageOf(error)}`,
      ...(error instanceof BackendError ? { backendErrorKind: error.kind } : {}),
    });
  }

  /** 全体の既定の許可。読む関数を受けていれば、呼ぶたびに読み直す */
  private async defaultPermissions(): Promise<Permissions> {
    const { permissions } = this.deps;
    if (typeof permissions !== 'function') return permissions;
    try {
      return await permissions();
    } catch (error) {
      // 古い許可のまま回さない: 人間が変えたはずの許可が効かないまま、気づかずに回り続けるため
      throw new StopJob({
        kind: 'error',
        detail: `全体の既定の許可を読む段: ${messageOf(error)}`,
      });
    }
  }

  /**
   * 人間が候補に付けた説明。ジョブごとに読み直す。
   */
  // 読めなくてもジョブを止めない: 説明は考える役への補足で、無くても生成はできるため。理由は呼び出しの記録に残る
  private async readCandidateNotes(): Promise<CandidateNotes> {
    if (this.deps.candidateNotes === undefined) return { notes: new Map() };
    try {
      return await this.deps.candidateNotes();
    } catch (error) {
      return { notes: new Map(), problem: `候補の説明を読めない: ${messageOf(error)}` };
    }
  }

  /** 全体の既定にジョブの上書きを重ね、バックエンドで使えないものを「使わない」に落とした許可 */
  private jobPermissions(
    spec: AutoJobSpec,
    defaults: Permissions,
    capabilities: BackendCapabilities,
    hasMask: boolean,
  ): EffectivePermissions & { merged: Permissions } {
    // ジョブの上書きを後に重ねる: 全体の既定が走行中に変わっても、ジョブで決めた許可は変えないため
    const merged = mergePermissions(defaults, spec.permissions ?? {});
    return { merged, ...effectivePermissions(merged, { capabilities, hasMask }) };
  }

  /** その回の許可・見せる候補・元画像の候補・マスク・考える役の出力スキーマのパラメータの部分 */
  private planParams(
    spec: AutoJobSpec,
    view: BackendView,
    defaults: Permissions,
    carry: Carry,
    mask: MaskIntervention | undefined,
  ): ParamsPlan {
    // マスクが無ければ inpaint は「使わない」になり、出力スキーマに現れない。ループはマスクを待たずに進む（M4:121）
    const { permissions, merged, disabled } = this.jobPermissions(
      spec,
      defaults,
      view.capabilities,
      mask !== undefined,
    );
    const candidates = shownCandidatesFor({
      permissions,
      lists: view.lists,
      notes: view.notes,
      requestGist: carry.intent,
      limits: this.budgetsFor(spec).candidates,
    });
    const sources = permissions.img2img.mode === 'auto' ? imageSourcesOf(carry) : [];
    const params = this.paramsSchema(permissions, candidates, sources, this.budgetsFor(spec));
    return { permissions, merged, disabled, candidates, sources, mask, params };
  }

  private paramsSchema(
    permissions: Permissions,
    candidates: ShownCandidates,
    sources: readonly { key: ImageSourceKey }[],
    budget: Budgets,
  ): ParamsSchema {
    return buildParamsSchema(permissions, {
      shown: candidates.shown,
      budget,
      imageSources: sources.map((source) => source.key),
    });
  }

  /**
   * いま inpaint に使えるマスク。いちばん新しい未使用のマスクで、マスクと塗った画像の両方が置かれていること。
   */
  private async usableMask(spec: AutoJobSpec): Promise<MaskIntervention | undefined> {
    const { store } = this.deps;
    const mask = activeMask(await store.listInterventions(spec.jobId));
    if (mask === undefined) return undefined;
    // 番号を取ったあと画像を置く前に落ちたマスクや、消された画像に塗ったマスクは使わない
    if ((await store.readMask(spec.jobId, mask.interventionId)) === undefined) return undefined;
    const painted = await store.readImage({ jobId: spec.jobId, ...mask.image });
    return painted === undefined ? undefined : mask;
  }

  private async loop(spec: AutoJobSpec, initial: RunningState, signal: AbortSignal): Promise<void> {
    const { store } = this.deps;
    const backendView = await this.viewBackend(spec, await this.defaultPermissions(), signal);
    let state = initial;
    for (;;) {
      signal.throwIfAborted();
      // 境目ごとに読み直す: 回の途中で届いた変更を、走っている段に触れずに次の回から効かせるため
      const conditions = await this.stopConditions(spec);
      const stop = await this.checkBoundary(spec, conditions, state);
      if (stop !== undefined) throw new StopJob(stop);

      const iteration = state.carry.completedIterations + 1;
      // 走っている段には触れず、境目で要点にする: 回の途中で届いた参照画像は、次の回の「考える」から効く（Issue #5 の I）
      const withReferences = await this.takeInReferences(spec, state.carry, iteration, signal);
      const mask = await this.usableMask(spec);
      // 回の境目ごとに読み直す: API で変えた全体の既定の許可を、走っている段に触れずに次の回から効かせるため
      const defaults = await this.defaultPermissions();
      await this.ensureCandidateLists(spec, backendView, defaults, signal);
      const paramsPlan = this.planParams(spec, backendView, defaults, withReferences, mask);
      // 回の始めに1回読み、考える役と見る役で同じ版を使う: 回の途中で人間が直した分は、次の回から効く
      const memoryItems = await this.readMemory();
      const think = await this.think(
        spec,
        conditions,
        withReferences,
        iteration,
        paramsPlan,
        memoryItems,
        signal,
      );
      // think.json から求め直す: 考えたあと state.json を書く前に落ちても、再開で同じ要点になるように
      const carry = applyIntegratedIntent(withReferences, think, this.budgetsFor(spec));
      const imageCount = await this.generate(spec, iteration, think, paramsPlan, signal);
      const judge = await this.judge(spec, carry, iteration, imageCount, memoryItems, signal);

      state = {
        ...state,
        carry: advanceCarry(carry, iteration, think.params, judge),
        imagesGenerated: state.imagesGenerated + imageCount,
      };
      await store.writeState(spec.jobId, state);
    }
  }

  /**
   * 要点の無い参照画像を、見る役に1度だけ見せて要点にし、carry の要点の欄を refs/ から作り直す。
   */
  private async takeInReferences(
    spec: AutoJobSpec,
    carry: Carry,
    iteration: number,
    signal: AbortSignal,
  ): Promise<Carry> {
    const { store, llm } = this.deps;
    const budget = this.budgetsFor(spec);
    const limits = budget.references;
    for (const reference of referencesWithoutGist(await store.listReferences(spec.jobId))) {
      const ref: ReferenceImageRef = { jobId: spec.jobId, refId: reference.refId };
      const messages = buildRefGistInput({
        carry,
        image: await store.loadPreview(ref, budget.imageLongEdge),
        ...(reference.note === undefined ? {} : { note: reference.note }),
        budget,
        limits,
        window: llm.describe('judge').window,
      });
      const outcome = await this.callLlm(spec.jobId, iteration, 'judge', 'ref-gist', messages, {
        schema: buildRefGistOutputSchema(limits),
        signal,
        sentImages: [ref],
        // 要点を印より先に書く: 印だけ残って落ちると、再開で「渡し済み」の画像を渡せず、要点も作れなくなるため。
        // 要点だけ残って落ちたときは、要点があるので2度は渡さない
        keepBeforeMarking: async (result) => {
          if (result.ok)
            await store.writeReferenceGist(spec.jobId, reference.refId, result.value.gist);
        },
      });
      if (!outcome.ok) {
        throw new StopJob({ kind: 'error', detail: `参照画像の要点: ${outcome.reason}` });
      }
    }
    const references = carriedReferences(await store.listReferences(spec.jobId), limits);
    return references.length === 0 ? carry : { ...carry, references };
  }

  private async checkBoundary(
    spec: AutoJobSpec,
    conditions: StopConditions,
    state: RunningState,
  ): Promise<StopReason | undefined> {
    const done = state.carry.completedIterations;
    const lastJudge =
      done === 0
        ? undefined
        : ((await this.deps.store.readStage(spec.jobId, done, 'judge')) as JudgeOutput | undefined);
    return checkStopAtBoundary({
      conditions,
      completedIterations: done,
      imagesGenerated: state.imagesGenerated,
      elapsedMs: this.now().getTime() - Date.parse(state.startedAt),
      judgeSaysStop: lastJudge?.canStop ?? false,
    });
  }

  private async think(
    spec: AutoJobSpec,
    conditions: StopConditions,
    carry: Carry,
    iteration: number,
    paramsPlan: ParamsPlan,
    memoryItems: readonly MemoryItem[] | undefined,
    signal: AbortSignal,
  ): Promise<ThinkOutput> {
    const { store, llm } = this.deps;
    const budget = this.budgetsFor(spec);
    const done = await store.readStage(spec.jobId, iteration, 'think');
    if (done !== undefined) return done as ThinkOutput;

    const plan = planInterventions(
      reopenClaimedBy(iteration, await store.listInterventions(spec.jobId)),
      budget.interventions,
    );
    const max = conditions.maxIterations;
    const messages = buildThinkInput({
      carry,
      progress: {
        iteration,
        ...(max === undefined ? {} : { remainingIterations: max - iteration + 1 }),
      },
      allowed: Object.keys(paramsPlan.params.schema.shape) as ParamKey[],
      budget,
      window: llm.describe('think').window,
      interventions: plan,
      candidates: paramsPlan.candidates,
      withImageSourceKeys: paramsPlan.sources.length > 0,
      ...this.memoryInput(memoryItems, budget.memory, 'think'),
    });
    const params = this.paramsShownIn(messages, paramsPlan, budget);
    // LLM を呼ぶ前に書く: 考える役に見せた形を残し、呼び出しの途中で落ちても何を外したかが残るようにするため
    await store.writeStage(spec.jobId, iteration, 'plan', {
      excluded: excludedOf(paramsPlan.merged, paramsPlan.disabled, params.omitted),
    });
    const outcome = await this.callLlm(spec.jobId, iteration, 'think', 'think', messages, {
      schema: buildThinkOutputSchema(params, budget, {
        withInterventions: plan.included.length > 0,
      }),
      signal,
    });
    if (!outcome.ok) throw new StopJob({ kind: 'error', detail: `考える段: ${outcome.reason}` });
    // 取り込んだ回を think.json より先に書く: think.json を「この回の考えるが済んだ」印にしているので、
    // 後に書くと、その間に落ちたとき取り込んだ指示が未反映のまま残り、次の回にもう一度載るため。
    // 先に書いて落ちた分は、再開でこの回を考え直すときに reopenClaimedBy が載せ直す
    for (const planned of plan.included) {
      await store.markInterventionApplied(spec.jobId, planned.interventionId, iteration);
    }
    await store.writeStage(spec.jobId, iteration, 'think', outcome.value);
    return outcome.value;
  }

  /**
   * 入力の上限で落ちた区画の元画像のキーを、出力スキーマから外す。見せていない画像は元画像に選ばせない（Issue #5 の G）。
   */
  private paramsShownIn(
    messages: BudgetedMessages,
    paramsPlan: ParamsPlan,
    budget: Budgets,
  ): ParamsSchema {
    const dropped = new Set(
      messages.report.notes.filter((n) => n.kind === 'dropped').map((n) => n.section),
    );
    const sectionOf = (key: ImageSourceKey) => (key.startsWith('ref:') ? 'references' : key);
    const shown = paramsPlan.sources.filter((source) => !dropped.has(sectionOf(source.key)));
    if (shown.length === paramsPlan.sources.length) return paramsPlan.params;
    return this.paramsSchema(paramsPlan.permissions, paramsPlan.candidates, shown, budget);
  }

  /**
   * 考える役が選んだ元画像のキーと、inpaint の強さを、生成の要求の画像の参照に写す。
   */
  private decidedForRequest(think: ThinkOutput, paramsPlan: ParamsPlan): Record<string, unknown> {
    const decided: Record<string, unknown> = { ...think.params };
    const img2img = think.params.img2img as { image: string } | undefined;
    if (img2img !== undefined) {
      const source = paramsPlan.sources.find((s) => s.key === img2img.image);
      if (source === undefined) {
        throw new StopJob({ kind: 'error', detail: `元画像のキー ${img2img.image} の画像が無い` });
      }
      decided.img2img = { ...img2img, image: source.ref };
    }
    if (think.params.inpaint !== undefined) {
      const { mask } = paramsPlan;
      if (mask === undefined) {
        throw new StopJob({ kind: 'error', detail: 'inpaint を選んだが、使えるマスクが無い' });
      }
      decided.inpaint = {
        ...think.params.inpaint,
        image: generatedImageRef(mask.image.iteration, mask.image.index),
        mask: maskImageRef(mask.interventionId),
      };
    }
    return decided;
  }

  /** 生成して画像と request.json を置く。済んでいれば置いた枚数だけを返す */
  private async generate(
    spec: AutoJobSpec,
    iteration: number,
    think: ThinkOutput,
    paramsPlan: ParamsPlan,
    signal: AbortSignal,
  ): Promise<number> {
    const { store, backend } = this.deps;
    const done = await store.readGeneration(spec.jobId, iteration);
    if (done !== undefined) {
      // 生成のあと印を付ける前に落ちていたら、ここで付け直す
      await this.markUsedMask(spec, iteration, done.request);
      return done.images.length;
    }

    let request: GenerationRequest;
    try {
      request = toGenerationRequest({
        decided: this.decidedForRequest(think, paramsPlan),
        permissions: paramsPlan.permissions,
        batchSize: spec.batchSize,
      });
    } catch (error) {
      if (error instanceof StopJob) throw error;
      // 「固定」の値がバックエンドに渡せない形のときなど。黙って AI の値に戻さず、理由付きで止める
      throw new StopJob({ kind: 'error', detail: `生成の要求を組む段: ${messageOf(error)}` });
    }
    let images;
    try {
      images = await loadRequestImages(store, spec.jobId, request);
    } catch (error) {
      throw new StopJob({ kind: 'error', detail: `生成の要求を組む段: ${messageOf(error)}` });
    }
    let result;
    try {
      result = await backend.generate(request, signal, images);
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
    await this.markUsedMask(spec, iteration, request);
    return result.images.length;
  }

  // 生成の要求を置いてから印を付ける: 先に付けると、生成の途中で落ちたとき、使っていないマスクが切れてしまうため
  private async markUsedMask(
    spec: AutoJobSpec,
    iteration: number,
    request: GenerationRequest,
  ): Promise<void> {
    const mask =
      request.inpaint === undefined ? undefined : parseInputImageRef(request.inpaint.mask);
    if (mask?.kind !== 'mask') return;
    await this.deps.store.markMaskUsed(spec.jobId, mask.maskId, iteration);
  }

  private async judge(
    spec: AutoJobSpec,
    carry: Carry,
    iteration: number,
    imageCount: number,
    memoryItems: readonly MemoryItem[] | undefined,
    signal: AbortSignal,
  ): Promise<JudgeOutput> {
    const { store, llm } = this.deps;
    const budget = this.budgetsFor(spec);
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
      ...this.memoryInput(memoryItems, budget.memory, 'judge'),
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
    options: {
      schema: ZodType<T>;
      signal: AbortSignal;
      sentImages?: AnyImageRef[];
      /** 記録を置いたあと、印を付ける前に、結果をファイルに残す */
      keepBeforeMarking?: (outcome: LlmCallOutcome<T>) => Promise<void>;
    },
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
    await options.keepBeforeMarking?.(outcome);
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

/** この回の「考える」が取り込みかけて、think.json を置く前に落ちた指示を、未反映に戻す */
function reopenClaimedBy(
  iteration: number,
  interventions: readonly InterventionRecord[],
): InterventionRecord[] {
  return interventions.map((intervention) => {
    if (intervention.kind !== 'instruction' || intervention.appliedInIteration !== iteration) {
      return intervention;
    }
    const { kind, interventionId, receivedAt, text } = intervention;
    return { kind, interventionId, receivedAt, text };
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
