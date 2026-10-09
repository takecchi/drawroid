import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * 画面の上端の帯。行き先の link は呼び手が渡す: このパッケージは router を知らないため。
 * link の見た目は `siteNavLinkClass` で揃える。
 */
export function SiteHeader({ brand, children }: { brand: ReactNode; children: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-1 px-4 py-2">
        <span className="mr-4 font-semibold tracking-tight">{brand}</span>
        {children}
      </nav>
    </header>
  );
}

export function siteNavLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'rounded-md px-3 py-1.5 text-sm transition-colors',
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );
}

export function Page({
  title,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <main className={cn('mx-auto max-w-5xl space-y-4 px-4 pt-6 pb-16', className)}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title !== undefined && <h1 className="text-2xl font-semibold">{title}</h1>}
          {action}
        </div>
      )}
      {children}
    </main>
  );
}
