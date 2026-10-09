import type { ComponentType, ReactNode } from 'react';

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { cn } from '@/lib/utils';

/** まだ何も無い一覧の代わりに置く。次に何をすればよいかを `description` と `action` で示す */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn('py-10', className)}>
      <EmptyHeader>
        {Icon !== undefined && (
          <EmptyMedia variant="icon" className="bg-accent text-accent-foreground">
            <Icon aria-hidden />
          </EmptyMedia>
        )}
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {description !== undefined && (
          <EmptyDescription className="text-xs">{description}</EmptyDescription>
        )}
      </EmptyHeader>
      {action !== undefined && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
