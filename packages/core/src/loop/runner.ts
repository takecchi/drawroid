import type { ZodType } from 'zod';

import type { GenerationRequest, ImageBackend } from '../backend.js';
import { BackendError } from '../backend-error.js';
import type { GenerationProgressPort } from '../conversation/generation-progress.js';
import type { AnyImageRef, ImageRef, JobStore, ReferenceImageRef } from '../job/store.js';
import {
  stopConditionsChangeSchema,
  type AdoptedRecord,
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
import type { InterventionMaterial, StoppedJobMaterial } from '../memory/distill/input.js';
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
import { adoptionCutting, latestAdoption } from './adoption.js';
import type { Budget } from './budget.js';
import {
  adoptAsBest,
  advanceCarry,
  createCarry,
  type Carry,
  type StageJudgement,
} from './carry.js';
import { LlmGate } from './llm-gate.js';
import {
  buildJudgeInput,
  buildRefGistInput,
  buildThinkInput,
  progressOf,
  type MemoryInput,
  type Progress,
} from './inputs.js';
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
  /** ジョブを作った会話での、そのジョブに関わる人間の発言（古い順）。止まったときの蒸留の材料に足す */
  conversationMessages?: (spec: AutoJobSpec) => Promise<readonly InterventionMaterial[]>;
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
  /**
   * ジョブの LLM の段を待たせる口（holdLlmStages）が、待たせ始めた・全部解けた（または、待たせたままジョブが終わった）ときに呼ばれる。
   * 話す役のターンが job.held を流すのに使う
   */
  onLlmStagesHeld?: (jobId: string, held: boolean) => void;
  /** LLM 呼び出しの ID。名前の順が呼び出しの順になる形にする */
  newCallId?: (now: Date) => string;
  /** 省けば進み具合を流さない。会話に属するジョブの生成を待つ間だけ、会話へ流す */
  generationProgress?: GenerationProgressPort;
  /**
   * 考える役・見る役が自分で出す思考の増分を受ける。画面に流すためで、次の入力には戻さない。
   * 確定した思考は、段の出力（think.json・judge.json）の reasoning に残す
   */
  onReasoning?: (event: {
    jobId: string;
    iteration: number;
    role: 'think' | 'judge';
    text: string;
    /** true なら、ここまでに流した思考を text で置き換える（出し直し・段のやり直しで、前の試行の思考を捨てる） */
    replace?: true;
  }) => void;
};

type Running = { jobId: string; controller: AbortController; gate: LlmGate };
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
const ADOPTED_STOP: StopReason = { kind: 'adopted', detail: '人間が画像を選んだ' };

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
    // 書いたあとにもう一度見る: 読んでから書くまでの間にランナーがこのジョブを拾っていたら、拾った側は「待っている」と
    // 読んで走り出しており、ここで書いた「止まった」を次の書き込みで上書きして回り続けるため。拾った側は最初の await
    // より前に running を立てるので、ここで見えなければ、拾った側の最初の読み出しは「止まった」を読んで返る
    if (this.running?.jobId === jobId) {
      this.running.controller.abort();
      await this.deps.backend.interrupt();
      return;
    }
    await this.distillAfterStop(jobId, stopped, HUMAN_STOP);
  }

  /**
   * 走っているジョブの LLM の段（考える・見る・参照画像の要点）を待たせる。戻り値の関数で解く。重ねて呼べて、全部解けたら解ける。
   * 走っている LLM の呼び出しはその呼び出しだけ abort し、解けたら出力ファイルの無い段からやり直す。生成（GPU）は待たせない。
   * 走っていないジョブには何もしない（解く関数は返す）。
   */
  holdLlmStages(jobId: string): () => void {
    if (this.running?.jobId !== jobId) return () => undefined;
    return this.running.gate.hold();
  }

  /**
   * 走行中・待ち行列のジョブに、人間が選んだ画像を置く。まだ見る役が見ていない回なら、見る役の代わりに採る。
   * お気に入りへの記録（selections/）はしない。呼び手の役目。
   */
  async adopt(
    jobId: string,
    image: { iteration: number; index: number },
  ): Promise<InterventionRecord> {
    await this.acceptingJob(jobId);
    const generation = await this.deps.store.readGeneration(jobId, image.iteration);
    if (generation === undefined || image.index >= generation.images.length) {
      throw new Error(`ジョブ ${jobId} の回 ${image.iteration} に画像 ${image.index} が無い`);
    }
    const record = await this.deps.store.addIntervention(
      jobId,
      { kind: 'adopt', image },
      this.now(),
    );
    // その回をまだ見る役が見ていなければ、走っている LLM の呼び出しをやり直させる: 見る役の呼び出しが走っていると、
    // 返るまで選択が効かず、見終えたあとの選択（job.adopted の出ない差し替え）になるため。やり直した段は選択を見て見る役を飛ばす。
    // 会話のターンが待たせている間（話す役の adopt_image）は、もともと走っていないので何も起きない。
    // 人が選んで済んだ回（adopted.json があり judge.json が無い）も、見る役はもう呼ばれないので切らない:
    // 切ると、後の回の LLM の呼び出しを呼び直させ、トークンを無駄に払うため
    if (
      this.running?.jobId === jobId &&
      (await this.deps.store.readStage(jobId, image.iteration, 'judge')) === undefined &&
      (await this.deps.store.readAdopted(jobId, image.iteration)) === undefined
    ) {
      this.running.gate.restartStage();
    }
    return record;
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
      // ジョブは話す役の予算を使わない。Budgets の形をそろえるためだけに既定を置く
      talk: DEFAULT_BUDGETS.talk,
    };
  }

  private async runJob(jobId: string): Promise<void> {
    const controller = new AbortController();
    const gate = new LlmGate((held) => this.notifyHeld(jobId, held));
    this.running = { jobId, controller, gate };
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
      gate.close();
      this.running = undefined;
    }
    // 止まった状態を書いて、走行中の印を外したあとに行う: 人間の停止で中断した合図を蒸留に引きずらず、蒸留の失敗が止まった理由を変えないため
    if (justStopped !== undefined) {
      await this.distillAfterStop(jobId, justStopped.state, justStopped.reason);
    }
  }

  private notifyHeld(jobId: string, held: boolean): void {
    try {
      this.deps.onLlmStagesHeld?.(jobId, held);
    } catch (error) {
      this.deps.log?.(`drawroid: ジョブ ${jobId} の待ちの通知に失敗した: ${messageOf(error)}`);
    }
  }

  /** LLM を呼ぶ段を、待たせている間は始めず、段の最中に待たせたら呼び出しだけ abort してやり直す */
  private llmStage<T>(
    signal: AbortSignal,
    run: (stageSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.running === undefined ? run(signal) : this.running.gate.runStage(signal, run);
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
        conversation: (await memory.conversationMessages?.(spec)) ?? [],
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
    const choosesImage =
      permissions.img2img.mode === 'auto' || permissions.controlnet.mode === 'auto';
    const sources = choosesImage ? imageSourcesOf(carry) : [];
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
      const adopting = await this.takeInAdoption(spec, state);
      state = adopting.state;
      if (adopting.stop !== undefined) throw new StopJob(adopting.stop);

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
        progressOf({
          iteration,
          conditions,
          imagesGenerated: state.imagesGenerated,
          elapsedMs: this.now().getTime() - Date.parse(state.startedAt),
        }),
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
      const outcome = await this.llmStage(signal, async (stageSignal) => {
        const messages = buildRefGistInput({
          carry,
          image: await store.loadPreview(ref, budget.imageLongEdge),
          ...(reference.note === undefined ? {} : { note: reference.note }),
          budget,
          limits,
          window: llm.describe('judge').window,
        });
        return this.callLlm(spec.jobId, iteration, 'judge', 'ref-gist', messages, {
          schema: buildRefGistOutputSchema(),
          signal: stageSignal,
          sentImages: [ref],
          // 要点を印より先に書く: 印だけ残って落ちると、再開で「渡し済み」の画像を渡せず、要点も作れなくなるため。
          // 要点だけ残って落ちたときは、要点があるので2度は渡さない
          keepBeforeMarking: async (result) => {
            if (result.ok)
              await store.writeReferenceGist(spec.jobId, reference.refId, result.value.gist);
          },
        });
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

  private think(
    spec: AutoJobSpec,
    progress: Progress,
    carry: Carry,
    iteration: number,
    paramsPlan: ParamsPlan,
    memoryItems: readonly MemoryItem[] | undefined,
    signal: AbortSignal,
  ): Promise<ThinkOutput> {
    return this.llmStage(signal, (stageSignal) =>
      this.thinkOnce(spec, progress, carry, iteration, paramsPlan, memoryItems, stageSignal),
    );
  }

  private async thinkOnce(
    spec: AutoJobSpec,
    progress: Progress,
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
    const messages = buildThinkInput({
      carry,
      progress,
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
    const thinking = this.collectReasoning(spec.jobId, iteration, 'think');
    const outcome = await this.callLlm(spec.jobId, iteration, 'think', 'think', messages, {
      schema: buildThinkOutputSchema(params, {
        withInterventions: plan.included.length > 0,
      }),
      signal,
      onReasoning: thinking.add,
      onRetry: thinking.reset,
    });
    if (!outcome.ok) throw new StopJob({ kind: 'error', detail: `考える段: ${outcome.reason}` });
    // 取り込んだ回を think.json より先に書く: think.json を「この回の考えるが済んだ」印にしているので、
    // 後に書くと、その間に落ちたとき取り込んだ指示が未反映のまま残り、次の回にもう一度載るため。
    // 先に書いて落ちた分は、再開でこの回を考え直すときに reopenClaimedBy が載せ直す
    for (const planned of plan.included) {
      await store.markInterventionApplied(spec.jobId, planned.interventionId, iteration);
    }
    await store.writeStage(spec.jobId, iteration, 'think', thinking.into(outcome.value));
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
    // 考える役の出力（モデル名・前処理名・画像のキー）を生成の要求の ControlNetUnit に写すのはここ。
    // バックエンド固有の形（Forge の args など）はアダプタが作るので、ここでは持たない。null は使わない
    const controlnet = think.params.controlnet as
      { model: string; module?: string; image: string } | null | undefined;
    if (controlnet === null) delete decided.controlnet;
    else if (controlnet !== undefined) {
      const source = paramsPlan.sources.find((s) => s.key === controlnet.image);
      if (source === undefined) {
        throw new StopJob({
          kind: 'error',
          detail: `ControlNet の入力画像のキー ${controlnet.image} の画像が無い`,
        });
      }
      decided.controlnet = [{ ...controlnet, image: source.ref }];
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
    // 進み具合は「生成を待っている間」にしか取れない。JobStore を包む橋渡し（F）はファイルの書き込みの写しなので、ここは表せず、generate の前後に置く
    const polling = await this.deps.generationProgress?.start({
      jobId: spec.jobId,
      conversationId: spec.conversationId,
      iteration,
      signal,
    });
    try {
      result = await backend.generate(request, signal, images);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new StopJob({
        kind: 'error',
        detail: `生成の段: ${messageOf(error)}`,
        ...(error instanceof BackendError ? { backendErrorKind: error.kind } : {}),
      });
    } finally {
      await polling?.stop();
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

  private judge(
    spec: AutoJobSpec,
    carry: Carry,
    iteration: number,
    imageCount: number,
    memoryItems: readonly MemoryItem[] | undefined,
    signal: AbortSignal,
  ): Promise<StageJudgement> {
    return this.llmStage(signal, (stageSignal) =>
      this.judgeOnce(spec, carry, iteration, imageCount, memoryItems, stageSignal),
    );
  }

  private async judgeOnce(
    spec: AutoJobSpec,
    carry: Carry,
    iteration: number,
    imageCount: number,
    memoryItems: readonly MemoryItem[] | undefined,
    signal: AbortSignal,
  ): Promise<StageJudgement> {
    const { store, llm } = this.deps;
    const budget = this.budgetsFor(spec);
    const done = await store.readStage(spec.jobId, iteration, 'judge');
    if (done !== undefined) return done as JudgeOutput;
    // 見る役より先に、人間の選択を見る: 選ばれた回の画像は、見る役に見せずに採る
    const adopted = await this.adoptionOf(spec, iteration);
    if (adopted !== undefined) return adoptedJudgement(adopted, imageCount);

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
    const thinking = this.collectReasoning(spec.jobId, iteration, 'judge');
    const outcome = await this.callLlm(spec.jobId, iteration, 'judge', 'judge', messages, {
      schema: buildJudgeOutputSchema(imageCount),
      signal,
      sentImages: refs,
      onReasoning: thinking.add,
      onRetry: thinking.reset,
    });
    if (!outcome.ok) throw new StopJob({ kind: 'error', detail: `見る段: ${outcome.reason}` });
    await store.writeStage(spec.jobId, iteration, 'judge', thinking.into(outcome.value));
    return outcome.value;
  }

  /** この回の、人間が選んだ記録。置いてあればそれ、無くて選ぶ口出しが来ていれば置いて返す */
  private async adoptionOf(
    spec: AutoJobSpec,
    iteration: number,
  ): Promise<AdoptedRecord | undefined> {
    const { store } = this.deps;
    const cut = await adoptionCutting(store, spec.jobId, iteration);
    if (cut === undefined) return undefined;
    if (cut.state === 'recorded') return cut.record;
    const chosen = cut.intervention;
    const record: AdoptedRecord = {
      by: 'human',
      image: chosen.image,
      score: 1,
      interventionId: chosen.interventionId,
      adoptedAt: this.now().toISOString(),
    };
    await store.writeAdopted(spec.jobId, iteration, record);
    return record;
  }

  /**
   * 回の境目で、人間の選択を取り込む。見る役が済んだ回の画像への選択は、最良候補を差し替える。
   * 取り込んだ選択には印を付け、二度は取り込まない。選択のあと、取り込んでいない人間の指示が無ければ、ジョブを止める。
   */
  // 最後の選択だけを見る: 古い選択を見ると、新しく選んだ画像を古い選択で上書きし直すため。
  // 取り込んだかを最良候補との一致や adopted.json の有無で推し量らない: 見る役が一番と見た画像を選んだときや、
  // 人が選んで済んだ回の別の画像を選び直したときに、取り込み済みと取り違えて、止まらずに描き続けるため
  private async takeInAdoption(
    spec: AutoJobSpec,
    state: RunningState,
  ): Promise<{ state: RunningState; stop?: StopReason }> {
    const { store } = this.deps;
    const done = state.carry.completedIterations;
    if (done === 0) return { state };
    const interventions = await store.listInterventions(spec.jobId);
    const chosen = latestAdoption(interventions);
    if (chosen === undefined || chosen.takenAfterIteration !== undefined) return { state };
    const { iteration, index } = chosen.image;
    if (iteration > done) return { state };
    const recorded =
      (await store.readAdopted(spec.jobId, iteration))?.interventionId === chosen.interventionId;
    // 前の回で見る役の代わりに記録した選択は、その回のあとの境目で取り込み済み（印を持たない前の版の跡も含む）
    if (recorded && iteration < done) return { state };
    // 見る役の代わりに記録した選択は、その回の評価として最良候補にもう入っている
    if (!recorded) {
      const think = (await store.readStage(spec.jobId, iteration, 'think')) as
        ThinkOutput | undefined;
      const judge = (await store.readStage(spec.jobId, iteration, 'judge')) as
        JudgeOutput | undefined;
      const carry = adoptAsBest(state.carry, {
        iteration,
        imageIndex: index,
        params: think?.params ?? {},
        issues: judge?.images[index]?.issues ?? [],
      });
      state = { ...state, carry };
      await store.writeState(spec.jobId, state);
    }
    // 最良候補を書いてから印を付ける: 先に付けて落ちると、選んだ画像が最良にならないまま取り込み済みになるため
    await store.markInterventionApplied(spec.jobId, chosen.interventionId, done);
    return hasPendingInstruction(interventions, done + 1)
      ? { state }
      : { state, stop: ADOPTED_STOP };
  }

  /**
   * 考える・見るの段で、モデルが自分で出す思考を受ける。増分は onReasoning へ流し、確定した思考は段の出力に足す。
   */
  // 段の出力（think.json・judge.json）に残す: 画面とファイルで見るためで、次の入力には戻さない
  // （持ち回すのは carry の決まった欄だけで、組み立て器は段の出力の reasoning を読まない）
  private collectReasoning(jobId: string, iteration: number, role: 'think' | 'judge') {
    let text = '';
    // 試行の最初の増分は、置き換えで流す: 待たせて段をやり直したとき、前の試行の思考に継ぎ足さないため
    let fresh = true;
    return {
      add: (delta: string) => {
        text += delta;
        this.deps.onReasoning?.({
          jobId,
          iteration,
          role,
          text: fresh ? text : delta,
          ...(fresh && { replace: true as const }),
        });
        fresh = false;
      },
      /** 出し直す。前の試行の思考は、段の出力にも画面にも残さない */
      reset: () => {
        text = '';
        fresh = true;
        this.deps.onReasoning?.({ jobId, iteration, role, text: '', replace: true });
      },
      into: <T extends object>(value: T): T =>
        text === '' ? value : { ...value, reasoning: text },
    };
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
      /** モデルが自分で出した思考を受ける（考える・見るの段だけ） */
      onReasoning?: (text: string) => void;
      /** 出し直す合図（考える・見るの段だけ） */
      onRetry?: () => void;
    },
  ): Promise<LlmCallOutcome<T>> {
    const startedAt = this.now();
    const onReasoning = options.onReasoning;
    const outcome = await this.deps.llm.generateStructured({
      role,
      purpose,
      schema: options.schema,
      messages,
      signal: options.signal,
      ...(onReasoning === undefined ? {} : { onReasoning }),
      ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
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

/** 次の回の「考える」が取り込む、人間の指示があるか（取り込みかけて落ちたものも含む） */
function hasPendingInstruction(
  interventions: readonly InterventionRecord[],
  nextIteration: number,
): boolean {
  return interventions.some(
    (i) =>
      i.kind === 'instruction' &&
      (i.appliedInIteration === undefined || i.appliedInIteration === nextIteration),
  );
}

/** 見る役を通さない評価。選んだ画像だけが満点で、ほかは 0 */
function adoptedJudgement(adopted: AdoptedRecord, imageCount: number): StageJudgement {
  return {
    images: Array.from({ length: imageCount }, (_, index) => ({
      score: index === adopted.image.index ? adopted.score : 0,
      issues: [],
    })),
    nextChange: '',
    canStop: false,
    adopted: true,
  };
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
