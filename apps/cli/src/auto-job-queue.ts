import type { AutoJobQueue as AutoJobQueuePort } from '@drawroid/api';
import {
  BackendError,
  JobRunner,
  THINK_PARAM_KEYS,
  type Budget,
  type GenerationDefaults,
  type ImageBackend,
  type JobStore,
  type LlmCall,
  type LlmCallOutcome,
  type LlmPort,
  type LlmRole,
  type LlmRoleInfo,
} from '@drawroid/core';
import { createLlm, type LlmConfig } from '@drawroid/llm';

const DEFAULTS: GenerationDefaults = {
  width: 1024,
  height: 1024,
  steps: 20,
  cfgScale: 7,
  negativePrompt: '',
};

type Env = Readonly<Record<string, string | undefined>>;

export type AutoJobQueueOptions = {
  store: JobStore;
  backend: ImageBackend | undefined;
  env: Env;
  budget: Budget;
  createLlm?: (config: LlmConfig, env: Env) => LlmPort;
  log: (line: string) => void;
};

/** バックエンドが無いとき、ランナーに渡すもの。kick が揃うまで回さないので、通常は呼ばれない */
const UNCONFIGURED_BACKEND: ImageBackend = {
  async probe() {
    throw unconfigured();
  },
  async listCandidates() {
    throw unconfigured();
  },
  async generate() {
    throw unconfigured();
  },
  async interrupt() {},
};

function unconfigured(): BackendError {
  return new BackendError('unreachable', '画像生成バックエンドが未設定');
}

export class AutoJobQueue implements AutoJobQueuePort {
  private readonly runner: JobRunner;
  private readonly backend: ImageBackend | undefined;
  private readonly makeLlm: (config: LlmConfig, env: Env) => LlmPort;
  private llm: LlmPort | undefined;

  constructor(private readonly options: AutoJobQueueOptions) {
    this.backend = options.backend;
    this.makeLlm = options.createLlm ?? ((config, env) => createLlm(config, { env }));
    // ランナーを作り直さず、委ね先だけを差し替える: 作り直すと、走っているジョブの中断と再開が絡むため
    const delegating: LlmPort = {
      describe: (role: LlmRole): LlmRoleInfo => this.requireLlm().describe(role),
      generateStructured: <T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>> =>
        this.requireLlm().generateStructured(call),
    };
    this.runner = new JobRunner({
      store: options.store,
      llm: delegating,
      backend: options.backend ?? UNCONFIGURED_BACKEND,
      budget: options.budget,
      allowed: THINK_PARAM_KEYS,
      defaults: DEFAULTS,
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

  kick(): void {
    if (this.llm === undefined || this.backend === undefined) return;
    this.runner.kick();
  }

  stop(jobId: string): Promise<void> {
    return this.runner.stop(jobId);
  }

  idle(): Promise<void> {
    return this.runner.idle();
  }

  private requireLlm(): LlmPort {
    if (this.llm === undefined) throw new Error('LLM が未設定');
    return this.llm;
  }
}
