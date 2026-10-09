import { XIcon } from 'lucide-react';
import { useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';

// `aria-modal` を手で足さない: Radix はこの属性を出さず、面の外へ `aria-hidden` を配るため
// 開くかどうかの判断を持たない: `md:hidden` で隠す形にすると、jsdom は CSS を評価せず試験で確かめられなくなるため
export function Drawer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  // 開いたときに焦点が在った所を覚えて、閉じたら戻す: Radix は `SheetTrigger` にしか焦点を戻さず、
  // 開くボタンは上の帯に在って Trigger ではないので、戻さないと焦点が body に落ちるため
  const returnFocusTo = useRef<HTMLElement | null>(null);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="left"
        // 閉じるボタンは自前で置く: shadcn の sheet の閉じるボタンは、読み上げで英語の「Close」と読まれるため
        showCloseButton={false}
        onOpenAutoFocus={() => {
          returnFocusTo.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusTo.current?.focus();
        }}
        // `w-` に `data-[side=left]:` を付ける: sheet の幅指定が同じ修飾子付きで、揃えないと tailwind-merge が衝突と見なせず sheet の 3/4 が勝つため
        className="max-w-[85%] gap-0 border-r border-border bg-card pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] text-base shadow-xl data-[side=left]:w-[17rem]"
      >
        {/* `aria-label` ではなく `Title` で名前を与える: Radix は `Title` が在るときだけ `aria-labelledby` を向けるため */}
        <SheetTitle className="sr-only">{label}</SheetTitle>
        {children}
        <SheetClose asChild>
          <Button variant="ghost" className="absolute top-3 right-3" size="icon-sm">
            <XIcon aria-hidden />
            <span className="sr-only">閉じる</span>
          </Button>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}
