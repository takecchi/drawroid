import type {
  Budget,
  ImageBackend,
  InterventionRecord,
  JobStore,
  ManualGenerationRunner,
  NewReference,
  ReferenceRecord,
  StopConditions,
  StopConditionsChange,
} from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';

/** 自動ジョブの待ち行列。JobRunner をそのまま渡せる形にしてある */
export type AutoJobQueue = {
  kick(): void;
  stop(jobId: string): Promise<void>;
  /** 断るときは InterventionRejectedError を投げる */
  addInstruction(jobId: string, text: string): Promise<InterventionRecord>;
  /** 重ねたあとの実際の止める条件を返す。断るときは InterventionRejectedError を投げる */
  changeStopConditions(jobId: string, change: StopConditionsChange): Promise<StopConditions>;
  /** 断るときは InterventionRejectedError を投げる */
  addReference(jobId: string, reference: NewReference): Promise<ReferenceRecord>;
};

export type LlmSettingsStore = {
  read(): Promise<unknown | undefined>;
  write(config: LlmConfig): Promise<void>;
};

export type ApiDeps = {
  backend: ImageBackend;
  store: JobStore;
  manualRunner: ManualGenerationRunner;
  autoQueue: AutoJobQueue;
  /** 自動ジョブの依頼を要約へ切り詰めるときの予算 */
  budget: Budget;
  llmSettings: LlmSettingsStore;
  /** API キーの環境変数が入っているかを確かめるため。値は応答に出さない */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
};
