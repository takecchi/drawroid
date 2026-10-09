import { basicPermissions } from '@drawroid/core';

import type { CandidateNotesStore, PermissionSettingsStore } from './deps.js';

/** 許可の設定を使わない試験のための、何も書かれていない置き場所 */
export const noPermissionSettings: PermissionSettingsStore = {
  base: basicPermissions({ width: 64, height: 64 }),
  read: async () => undefined,
  write: async () => undefined,
};

/** 候補の説明を使わない試験のための、何も書かれていない置き場所 */
export const noCandidateNotes: CandidateNotesStore = {
  read: async () => ({ notes: new Map() }),
  write: async () => undefined,
};
