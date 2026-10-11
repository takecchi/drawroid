import { Fragment, useId, type ComponentType, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { BrandMark } from './brand-mark';

export interface AppSidebarItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  // まとまりを別の配列に分けない: 行き先を1つ足すときに足す場所が2か所に割れるため
  section?: string;
}

// link を描く口を受ける: この層は router を知らないため
export type AppSidebarRenderLink = (
  item: AppSidebarItem,
  slot: { className: (isActive: boolean) => string; children: ReactNode },
) => ReactNode;

// 広い画面の脇と狭い画面のドロワーに同じものを置く: 別々に書くと、行き先を1つ足したときに片方だけ増えるため
export function AppSidebar({
  items,
  renderLink,
  inDrawer = false,
  className,
}: {
  items: readonly AppSidebarItem[];
  renderLink: AppSidebarRenderLink;
  inDrawer?: boolean;
  className?: string;
}) {
  const idPrefix = useId();
  return (
    <nav
      aria-label="行き先"
      className={cn(
        'flex flex-col bg-card',
        // `inDrawer` では枠・幅・左端の safe-area を付けない: Drawer が既に持っており、足すと二重に効くため
        inDrawer
          ? 'min-h-0 flex-1'
          : 'w-56 shrink-0 border-r border-border pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]',
        className,
      )}
    >
      <div className="px-4 pt-4 pb-3">
        <BrandMark />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sectionsOf(items).map((group, index) => {
          const headingId = `${idPrefix}-section-${index}`;
          const labelled = group.section !== undefined && group.section.length > 0;
          return (
            <Fragment key={group.items[0]?.to}>
              {index === 0 ? null : labelled ? (
                <SectionStart id={headingId} label={group.section} inDrawer={inDrawer} />
              ) : (
                <div role="separator" className="mx-2.5 my-2 border-t border-border" />
              )}
              <ul aria-labelledby={index > 0 && labelled ? headingId : undefined}>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      {renderLink(item, {
                        className: (isActive) => sidebarLinkClassName({ isActive, inDrawer }),
                        children: (
                          <>
                            <Icon className="size-4 shrink-0" aria-hidden />
                            <span className="flex-1 truncate">{item.label}</span>
                          </>
                        ),
                      })}
                    </li>
                  );
                })}
              </ul>
            </Fragment>
          );
        })}
      </div>
    </nav>
  );
}

// 行き先を並べた順のまま、同じ section が続く所で区切る
function sectionsOf(
  items: readonly AppSidebarItem[],
): { section?: string; items: AppSidebarItem[] }[] {
  const groups: { section?: string; items: AppSidebarItem[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last !== undefined && last.section === item.section) last.items.push(item);
    else
      groups.push({ ...(item.section !== undefined && { section: item.section }), items: [item] });
  }
  return groups;
}

// 見出しを `aria-hidden` にしない: 読み上げでも「いまどのまとまりか」が分かるように。
// 見出しは項目（li）の外に置き、組の ul の名前にする: 中に入れると、最初の項目が「描く 依頼」と1つに聞こえるため
function SectionStart({
  id,
  label,
  inDrawer,
}: {
  id: string;
  label: string | undefined;
  inDrawer: boolean;
}) {
  return (
    <p
      id={id}
      className={cn(
        'px-2.5 pb-1 text-[11px] tracking-wide text-muted-foreground/80',
        inDrawer ? 'pt-4' : 'pt-3',
      )}
    >
      {label}
    </p>
  );
}

export function sidebarLinkClassName({
  isActive,
  inDrawer,
}: {
  isActive: boolean;
  inDrawer: boolean;
}): string {
  return cn(
    'mb-0.5 flex items-center gap-2.5 rounded-sm px-2.5 text-sm transition-colors',
    // ドロワーと、指で操作するとき（pointer: coarse）は、指で押せる高さ（44px）にする
    inDrawer ? 'min-h-11' : 'py-1.5 pointer-coarse:min-h-11',
    isActive
      ? 'lumen-edge bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );
}
