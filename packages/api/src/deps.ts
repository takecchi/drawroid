import type { ImageBackend, JobStore, ManualGenerationRunner } from '@drawroid/core';

export type ApiDeps = {
  backend: ImageBackend;
  store: JobStore;
  manualRunner: ManualGenerationRunner;
};
