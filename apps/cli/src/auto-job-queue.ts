import type { AutoJobQueue as AutoJobQueuePort } from '@drawroid/api';
import {
  basicPermissions,
  JobRunner,
  type JobRunnerDeps,
  mergePermissions,
  type Budget,
  type CandidateNotes,
  type GenerationProgressPort,
  type ImageBackend,
  type JobMemory,
  type InterventionRecord,
  type JobStore,
  type LlmCall,
  type LlmCallOutcome,
  type LlmPort,
  type LlmRole,
  type LlmRoleInfo,
  type TalkStepCall,
  type TalkStepPart,
  type MaskIntervention,
  type NewMask,
  type NewReference,
  type Permissions,
  type ReferenceRecord,
  type StopConditions,
  type StopConditionsChange,
} from '@drawroid/core';
import { createLlm, type LlmConfig } from '@drawroid/llm';

// 設定に許可を書かないときの土台。M2 の可動範囲（プロンプト・seed・steps・CFG を AI に任せ、大きさは固定）
export const BASE_PERMISSIONS = basicPermissions({ width: 1024, height: 1024 });

type Env = Readonly<Record<string, string | undefined>>;

export type AutoJobQueueOptions = {
  store: JobStore;
  backend: ImageBackend;
  env: Env;
  budget: Budget;
  /** config.json の permissions を読む。回の境目ごとに呼ばれ、全体の既定の許可の土台に重ねる */
  permissions?: () => Promise<Partial<Permissions>>;
  /** candidate-notes.json を読む。ジョブの始めに1回呼ばれる */
  candidateNotes?: () => Promise<CandidateNotes>;
  /** 記憶の置き場所と蒸留の記録の置き場所。省けば記憶なしで回る */
  memory?: JobMemory;
  /** 会話に属するジョブの生成の進み具合の流し先。省けば流さない */
  generationProgress?: GenerationProgressPort;
  createLlm?: (config: LlmConfig, env: Env) => LlmPort;
  /** 考える役・見る役の思考の増分を受ける（会話へ流すため） */
  onReasoning?: JobRunnerDeps['onReasoning'];
  /** ジョブの LLM の段が待たされ始めた・解けたとき（会話へ job.held を流すため） */
  onLlmStagesHeld?: JobRunnerDeps['onLlmStagesHeld'];
  log: (line: string) => void;
};

export class AutoJobQueue implements AutoJobQueuePort {
  private readonly runner: JobRunner;
  private readonly makeLlm: (config: LlmConfig, env: Env) => LlmPort;
  private llm: LlmPort | undefined;

  constructor(private readonly options: AutoJobQueueOptions) {
    this.makeLlm = options.createLlm ?? ((config, env) => createLlm(config, { env }));
    // ランナーを作り直さず、委ね先だけを差し替える: 作り直すと、走っているジョブの中断と再開が絡むため
    const delegating: LlmPort = {
      describe: (role: LlmRole): LlmRoleInfo => this.requireLlm().describe(role),
      generateStructured: <T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>> =>
        this.requireLlm().generateStructured(call),
      streamStep: (call: TalkStepCall): AsyncIterable<TalkStepPart> =>
        this.requireLlm().streamStep(call),
    };
    this.runner = new JobRunner({
      store: options.store,
      llm: delegating,
      backend: options.backend,
      budget: options.budget,
      permissions: async () =>
        mergePermissions(BASE_PERMISSIONS, (await options.permissions?.()) ?? {}),
      ...(options.candidateNotes !== undefined && { candidateNotes: options.candidateNotes }),
      ...(options.memory !== undefined && { memory: options.memory }),
      ...(options.generationProgress !== undefined && {
        generationProgress: options.generationProgress,
      }),
      ...(options.onReasoning !== undefined && { onReasoning: options.onReasoning }),
      ...(options.onLlmStagesHeld !== undefined && { onLlmStagesHeld: options.onLlmStagesHeld }),
      log: options.log,
    });
  }

  configure(config: LlmConfig | undefined): void {
    this.llm = undefined;
    if (config === undefined) return;
    try {
      this.llm = this.makeLlm(config, this.options.env);
    } catch (error) {
      // 理由だけを出す: エラーの文面は変数の名前までで、値は含まれない（設定にも値は置かせない）
      this.options.log(
        `drawroid: LLM の設定から LLM を作れない。未設定のままにする: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 今設定されている LLM。未設定なら undefined */
  currentLlm(): LlmPort | undefined {
    return this.llm;
  }

  kick(): void {
    if (this.llm === undefined) return;
    this.runner.kick();
  }

  stop(jobId: string): Promise<void> {
    return this.runner.stop(jobId);
  }

  // LLM が未設定でも受ける: 口出しはファイルに置くだけで、LLM を使うのは次に回ったときなため
  addInstruction(jobId: string, text: string): Promise<InterventionRecord> {
    return this.runner.addInstruction(jobId, text);
  }

  changeStopConditions(jobId: string, change: StopConditionsChange): Promise<StopConditions> {
    return this.runner.changeStopConditions(jobId, change);
  }

  /** 走っているジョブの LLM の段を待たせる。戻り値で解く */
  holdLlmStages(jobId: string): () => void {
    return this.runner.holdLlmStages(jobId);
  }

  adopt(jobId: string, image: { iteration: number; index: number }): Promise<InterventionRecord> {
    return this.runner.adopt(jobId, image);
  }

  addReference(jobId: string, reference: NewReference): Promise<ReferenceRecord> {
    return this.runner.addReference(jobId, reference);
  }

  addReferences(jobId: string, references: readonly NewReference[]): Promise<ReferenceRecord[]> {
    return this.runner.addReferences(jobId, references);
  }

  addMask(jobId: string, mask: NewMask): Promise<MaskIntervention> {
    return this.runner.addMask(jobId, mask);
  }

  idle(): Promise<void> {
    return this.runner.idle();
  }

  private requireLlm(): LlmPort {
    if (this.llm === undefined) throw new Error('LLM が未設定');
    return this.llm;
  }
}
