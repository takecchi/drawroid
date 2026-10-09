import type {
  Budget,
  ImageBackend,
  InterventionRecord,
  JobStore,
  ManualGenerationRunner,
  MemoryStore,
  MaskIntervention,
  NewMask,
  NewReference,
  ReferenceRecord,
  StopConditions,
  StopConditionsChange,
} from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';

import type { BackendSettingsPort } from './backend-settings.js';

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
  /** 塗った画像があるかは呼び手が確かめる。断るときは InterventionRejectedError を投げる */
  addMask(jobId: string, mask: NewMask): Promise<MaskIntervention>;
};

export type LlmSettingsStore = {
  read(): Promise<unknown | undefined>;
  write(config: LlmConfig): Promise<void>;
};

export type ApiDeps = {
  backend: ImageBackend;
  store: JobStore;
  memoryStore: MemoryStore;
  manualRunner: ManualGenerationRunner;
  backendSettings: BackendSettingsPort;
  autoQueue: AutoJobQueue;
  /** 自動ジョブの依頼を要約へ切り詰めるときの予算 */
  budget: Budget;
  llmSettings: LlmSettingsStore;
  /** API キーの環境変数が入っているかを確かめるため。値は応答に出さない */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
};
