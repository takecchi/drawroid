import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type Author = 'human' | 'ai';

const AUTHOR_STYLES = {
  human: { box: 'border-human bg-human/5', label: 'text-human' },
  ai: { box: 'border-ai bg-ai/5', label: 'text-ai' },
} as const;

// 枠の色と左の線で分ける: 人間の指示と AI の判断が並ぶ記録で、文字を読まなくてもどちらかが分かるようにするため
export function AuthorMark({
  author,
  label,
  meta,
  as: Tag = 'div',
  className,
  children,
}: {
  author: Author;
  /** 省くと色の印だけになる（中身の見出しで作者が分かるとき） */
  label?: string;
  /** 文言の横に添える時刻など */
  meta?: ReactNode;
  as?: 'div' | 'section';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Tag
      data-author={author}
      className={cn(
        'space-y-1 rounded-r-md border-l-4 px-3 py-2 text-sm',
        AUTHOR_STYLES[author].box,
        className,
      )}
    >
      {/* 文言と時刻を枠の直下に置く（行で包まない）: 文言の親が記録1件ぶんの枠になり、文言から記録の中身を辿れるようにするため */}
      {label !== undefined && <AuthorLabel author={author}>{label}</AuthorLabel>}
      {meta !== undefined && <span className="ml-2 text-xs text-muted-foreground">{meta}</span>}
      {children}
    </Tag>
  );
}

export function AuthorLabel({ author, children }: { author: Author; children: string }) {
  return (
    <strong className={cn('text-xs font-semibold', AUTHOR_STYLES[author].label)}>{children}</strong>
  );
}

export function ImageGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3', className)}>
      {children}
    </div>
  );
}

export type ImageVerdict = 'favorite' | 'rejected';

/**
 * 格子の1枚。中に canvas が出ている間（マスクを塗っている間）は行の幅を占める: 1枡では狭くて塗れないため。
 */
export function ImageCard({
  href,
  src,
  alt,
  verdict,
  caption,
  children,
}: {
  href: string;
  src: string;
  alt: string;
  verdict?: ImageVerdict | null;
  caption?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <figure
      data-verdict={verdict ?? undefined}
      className={cn(
        'space-y-2 rounded-lg border border-border bg-card p-2',
        verdict === 'favorite' && 'border-ok ring-1 ring-ok',
        verdict === 'rejected' && 'opacity-60',
        // 塗る間は上の縮小版を隠す: 塗る所に同じ画像が大きく出ており、2枚並ぶと縦に長くなるだけのため
        'has-[canvas]:col-span-full [&:has(canvas)>a]:hidden',
      )}
    >
      <a href={href} className="block">
        <img src={src} alt={alt} className="block h-auto w-full rounded-md bg-muted" />
      </a>
      {caption !== undefined && (
        <figcaption className="space-y-1 text-xs text-muted-foreground">{caption}</figcaption>
      )}
      {children}
    </figure>
  );
}
