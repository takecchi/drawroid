import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';

import { BrandMark } from './brand-mark';

/** 狭い画面の上の帯の高さ。会話の画面（`ChatLayout`）は、画面の高さからこの分を引いて入力欄を下端に置く */
export const MOBILE_TOP_BAR_HEIGHT_CLASS = 'h-14';

export function MobileTopBar({
  onOpenNav,
  trailing,
}: {
  onOpenNav: () => void;
  trailing?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 shrink-0 border-b border-border bg-card pt-[var(--safe-top)] pr-[var(--safe-right)] pl-[var(--safe-left)]">
      {/* 高さを固定する: 会話の画面がこの高さを引いて入力欄を置くので、中身で伸びると入力欄が画面の外へ押し出されるため */}
      <div className="flex h-14 items-center gap-1 px-2">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="メニューを開く"
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <BrandMark />
        </div>
        {trailing}
      </div>
    </header>
  );
}
