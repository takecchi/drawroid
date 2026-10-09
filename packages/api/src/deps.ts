import type { Budget, ImageBackend, JobStore, ManualGenerationRunner } from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';

/** 自動ジョブの待ち行列。JobRunner をそのまま渡せる形にしてある */
export type AutoJobQueue = { kick(): void; stop(jobId: string): Promise<void> };

export type LlmSettingsStore = {
  read(): Promise<unknown | undefined>;
  write(config: LlmConfig): Promise<void>;
};

import type { BackendSettingsPort } from './backend-settings.js';

export type ApiDeps = {
  backend: ImageBackend;
  store: JobStore;
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
