import type { MouseEvent, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export const MAIN_CONTENT_ID = 'main-content';
/** 会話の発言欄。「発言欄へ移動」の行き先 */
export const COMPOSER_FIELD_ID = 'composer-field';

/**
 * キーボードで最初に届く飛び先。既定は「本文へ移動」で、脇の行き先を毎回 Tab で通り抜けずに済むように。
 * 行き先の要素が無ければ、何もしない
 */
export function SkipLink({
  className,
  targetId = MAIN_CONTENT_ID,
  children = '本文へ移動',
}: {
  className?: string;
  targetId?: string;
  children?: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(targetId);
    if (target === null) return;
    // URL の `#` を書き換えない: router の履歴を汚さないため
    event.preventDefault();
    // 本文は画面全体を囲むので動かさない。ほかの行き先（発言欄など）は画面の外にあることがあるので、見える所まで送る
    target.focus({ preventScroll: targetId === MAIN_CONTENT_ID });
  };
  return (
    <a
      href={`#${targetId}`}
      onClick={onClick}
      className={cn(
        'sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground',
        className,
      )}
    >
      {children}
    </a>
  );
}
