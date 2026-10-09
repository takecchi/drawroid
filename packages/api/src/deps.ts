import type { ImageBackend, JobStore, ManualGenerationRunner } from '@drawroid/core';

import type { BackendSettingsPort } from './backend-settings.js';

export type ApiDeps = {
  backend: ImageBackend;
  store: JobStore;
  manualRunner: ManualGenerationRunner;
  backendSettings: BackendSettingsPort;
};
