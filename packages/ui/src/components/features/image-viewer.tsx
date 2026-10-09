import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';

import { Button } from '../common';

/** 大きく見る画像1枚。並びは、回の順・回の中の番の順（左右の送りがこの順に進む） */
export interface ViewerImage {
  /** 画面の中で一意。縮小版のボタンの `data-viewer-key` と同じ値にする（閉じたとき、焦点をそこへ戻す） */
  key: string;
  /** 大きく見せる画像（縮小版より大きいもの） */
  src: string;
  /** 原寸の画像（新しいタブで開く） */
  fullSrc: string;
  /** 読み上げと見出しに使う呼び方（「3 回目の画像 2 番」） */
  title: string;
  alt: string;
}

// これより大きく横へ動かしたら、前後の画像へ送る（px）。縦の動きより横の動きが大きいときだけ
const SWIPE_PX = 48;

/**
 * 画像を大きく見る窓。左右のキー・ボタン・狭い画面のスワイプで、並びの前後の画像へ送る（回をまたいで続く）。Esc で閉じる。
 * 閉じたら、最後に見ていた画像の縮小版へ焦点を戻す: 送ったあとに、開いたときの縮小版へ戻すと、見ていた場所から離れるため。
 * alteroid の ZoomableImage（1枚を窓で見る）の形を土台に、送りを足した。
 */
export function ImageViewer({
  images,
  openKey,
  onOpenKeyChange,
  details,
}: {
  images: readonly ViewerImage[];
  /** 開いている画像の key。閉じているなら null */
  openKey: string | null;
  onOpenKeyChange: (key: string | null) => void;
  /** 画像の下に添えるもの（評価・選ぶボタンなど）。画面が渡す */
  details?: (image: ViewerImage) => ReactNode;
}) {
  const index = openKey === null ? -1 : images.findIndex((image) => image.key === openKey);
  const image = index < 0 ? undefined : images[index];
  // 閉じる直前の key を覚える: 閉じた瞬間に openKey は null になり、どの縮小版へ戻すかが分からなくなるため
  const lastKey = useRef<string | null>(null);
  if (image !== undefined) lastKey.current = image.key;
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const go = (step: -1 | 1) => {
    const next = images[index + step];
    if (next !== undefined) onOpenKeyChange(next.key);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'ArrowRight') go(1);
    else return;
    event.preventDefault();
  };
  const onPointerDown = (event: PointerEvent) => {
    swipeStart.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (start === null) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return;
    go(dx < 0 ? 1 : -1);
  };

  return (
    <Dialog open={image !== undefined} onOpenChange={(open) => !open && onOpenKeyChange(null)}>
      {image !== undefined && (
        <DialogContent
          aria-describedby={undefined}
          // 閉じるボタンは自前で置く: 既定のボタンは英語の名前（Close）を持つため
          showCloseButton={false}
          onKeyDown={onKeyDown}
          onCloseAutoFocus={(event) => {
            const key = lastKey.current;
            const thumbnail =
              key === null
                ? null
                : document.querySelector<HTMLElement>(`[data-viewer-key="${CSS.escape(key)}"]`);
            if (thumbnail === null) return;
            event.preventDefault();
            thumbnail.focus();
          }}
          className="flex h-[92dvh] w-[96vw] max-w-[96vw] flex-col gap-2 p-3 sm:max-w-[min(96vw,72rem)]"
        >
          <div className="flex items-center gap-2">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm">
              {image.title}
              <span className="ml-2 text-xs font-normal text-muted-foreground" data-numeric>
                （{images.length} 枚中 {index + 1} 枚目）
              </span>
            </DialogTitle>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" aria-label="閉じる">
                <X aria-hidden />
              </Button>
            </DialogClose>
          </div>
          <div
            className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center select-none"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (swipeStart.current = null)}
          >
            <img
              key={image.key}
              src={image.src}
              alt={image.alt}
              draggable={false}
              className="max-h-full max-w-full rounded-md object-contain"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" aria-label="前の画像" disabled={index === 0} onClick={() => go(-1)}>
              <ChevronLeft aria-hidden />
              前へ
            </Button>
            <Button
              size="sm"
              aria-label="次の画像"
              disabled={index === images.length - 1}
              onClick={() => go(1)}
            >
              次へ
              <ChevronRight aria-hidden />
            </Button>
            <a
              href={image.fullSrc}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              原寸を新しいタブで開く
            </a>
          </div>
          {details?.(image)}
        </DialogContent>
      )}
    </Dialog>
  );
}
