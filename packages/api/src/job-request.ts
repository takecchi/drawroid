import type { JobSpec } from '@drawroid/core';

/** 何を描いたジョブかを表す文: 自動なら依頼の文、手動ならプロンプト */
export function jobRequestText(spec: JobSpec): string {
  return spec.kind === 'auto' ? spec.request : spec.request.prompt;
}
