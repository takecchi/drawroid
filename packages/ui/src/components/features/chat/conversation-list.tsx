import type { ReactNode } from 'react';

import { Badge } from '../../common';

/**
 * 会話の一覧の1行の中身。行そのもの（link）は画面が包む: このパッケージは router を知らないため。
 */
export function ConversationSummary({
  title,
  preview,
  running = false,
  meta,
}: {
  title: string;
  /** 最後の発言の先頭 */
  preview?: string;
  running?: boolean;
  /** 更新の時刻など */
  meta?: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="truncate font-medium">{title}</span>
        {running && <Badge tone="ok">応答中</Badge>}
        {meta !== undefined && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>
        )}
      </div>
      {preview !== undefined && preview !== '' && (
        <p className="truncate text-sm text-muted-foreground">{preview}</p>
      )}
    </div>
  );
}
