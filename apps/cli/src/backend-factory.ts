import type { BackendKind } from '@drawroid/api';
import { A1111Backend } from '@drawroid/backend-a1111';
import { ForgeBackend } from '@drawroid/backend-forge';
import type { ImageBackend } from '@drawroid/core';

import type { BackendOptions } from './backend-settings.js';

/** 起動のログに出す製品名 */
export const BACKEND_LABELS = { forge: 'Forge', a1111: 'A1111' } as const satisfies Record<
  BackendKind,
  string
>;

// どのアダプタを使うかの分岐は、組み立ての根のここだけに置く: ループの中心にバックエンドごとの分岐を持ち込まないため
export function backendFactory(kind: BackendKind): (options: BackendOptions) => ImageBackend {
  switch (kind) {
    case 'forge':
      return (options) => new ForgeBackend(options);
    case 'a1111':
      return (options) => new A1111Backend(options);
  }
}
