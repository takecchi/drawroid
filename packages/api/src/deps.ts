import type { Budget, JobStore } from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';

export type AutoJobQueue = { kick(): void; stop(jobId: string): Promise<void> };

export type LlmSettingsStore = {
  read(): Promise<unknown | undefined>;
  write(config: LlmConfig): Promise<void>;
};

export type ApiDeps = {
  store: JobStore;
  queue: AutoJobQueue;
  budget: Budget;
  llmSettings: LlmSettingsStore;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
};
