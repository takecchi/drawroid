import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

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
