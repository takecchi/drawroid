import { useBackendSettings } from '@drawroid/swr';

import type { BackendKind } from './backend-error';

// 読み込み中・読めないときは undefined: 文面は特定の名前に寄せず中立に書く
export function useBackendKind(): BackendKind | undefined {
  return useBackendSettings().data?.kind;
}
