import type { ImageBackend, JobStore, ManualGenerationRunner, MemoryStore } from '@drawroid/core';

import type { BackendSettingsPort } from './backend-settings.js';

export type ApiDeps = {
  backend: ImageBackend;
  store: JobStore;
  memoryStore: MemoryStore;
  manualRunner: ManualGenerationRunner;
  backendSettings: BackendSettingsPort;
};
