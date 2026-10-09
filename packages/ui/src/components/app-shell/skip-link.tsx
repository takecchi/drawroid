import type { MouseEvent } from 'react';

import { cn } from '@/lib/utils';

export const MAIN_CONTENT_ID = 'main-content';

/** キーボードで最初に届く「本文へ移動」。脇の行き先を毎回 Tab で通り抜けずに済むように */
export function SkipLink({ className }: { className?: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.getElementById(MAIN_CONTENT_ID);
    if (main === null) return;
    // URL の `#` を書き換えない: router の履歴を汚さないため
    event.preventDefault();
    main.focus({ preventScroll: true });
  };
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={onClick}
      className={cn(
        'sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground',
        className,
      )}
    >
      本文へ移動
    </a>
  );
}
