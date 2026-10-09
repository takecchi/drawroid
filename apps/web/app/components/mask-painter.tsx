import { addMask, isApiError } from '@drawroid/swr';
import { Button, CheckboxField, ErrorNote, Field, Input, OkNote } from '@drawroid/ui';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

import { encodeMaskPng } from '../lib/mask-png';
import { drawMask, toImagePoint, type MaskSize, type Stroke } from '../lib/mask-strokes';

const DEFAULT_RADIUS = 32;

/**
 * 回の画像1枚の上に inpaint のマスクを塗り、口出しとして送る。白く塗った所が、次の回の inpaint で描き直される。
 */
export function MaskPainter({
  jobId,
  image,
}: {
  jobId: string;
  image: { iteration: number; index: number; url: string };
}) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<MaskSize | undefined>();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [erase, setErase] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 画面の canvas にも、送るものと同じマスクを描く: 見えている塗りと送るマスクがずれないように
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (size === undefined || context == null) return;
    drawMask(context, strokes, size);
  }, [strokes, size]);

  if (!open) {
    return (
      <Button className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
        マスクを塗る
      </Button>
    );
  }

  function pointOf(event: PointerEvent<HTMLCanvasElement>) {
    if (size === undefined) return undefined;
    const box = event.currentTarget.getBoundingClientRect();
    return toImagePoint({ x: event.clientX, y: event.clientY }, box, size);
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    const point = pointOf(event);
    if (point === undefined) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrawing(true);
    setSent(false);
    setStrokes((current) => [...current, { points: [point], radius, erase }]);
  }

  function extend(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    const point = pointOf(event);
    if (point === undefined) return;
    setStrokes((current) => {
      const last = current.at(-1);
      if (last === undefined) return current;
      return [...current.slice(0, -1), { ...last, points: [...last.points, point] }];
    });
  }

  async function send() {
    if (size === undefined) return;
    setSending(true);
    setError(undefined);
    try {
      const png = await encodeMaskPng(strokes, size);
      await addMask(jobId, { iteration: image.iteration, index: image.index }, png);
      setStrokes([]);
      setSent(true);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setSending(false);
    }
  }

  const alt = `${image.iteration} 回目の画像 ${image.index}`;
  return (
    <div className="space-y-2">
      <div className="relative inline-block max-w-full">
        <img
          src={image.url}
          alt={alt}
          className="block max-w-full"
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
        {/* 黒は screen で透けるので、白く塗った所だけが画像の上に見える */}
        <canvas
          ref={canvasRef}
          aria-label="マスクを塗る所"
          width={size?.width ?? 0}
          height={size?.height ?? 0}
          className="absolute inset-0 size-full cursor-crosshair touch-none opacity-60 mix-blend-screen"
          onPointerDown={start}
          onPointerMove={extend}
          onPointerUp={() => setDrawing(false)}
          onPointerLeave={() => setDrawing(false)}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="筆の太さ（px）">
          <Input
            type="number"
            min={1}
            max={512}
            value={radius}
            onChange={(event) => setRadius(Math.max(1, Number(event.target.value) || 1))}
            className="h-7 w-20"
          />
        </Field>
        <CheckboxField
          label="消しゴム"
          checked={erase}
          onChange={(event) => setErase(event.target.checked)}
          className="pb-1"
        />
        <Button
          className="h-7 px-2 text-xs"
          disabled={strokes.length === 0}
          onClick={() => setStrokes((current) => current.slice(0, -1))}
        >
          ひとつ戻す
        </Button>
        <Button
          className="h-7 px-2 text-xs"
          disabled={strokes.length === 0}
          onClick={() => setStrokes([])}
        >
          全部消す
        </Button>
        <Button
          className="h-7 px-2 text-xs"
          disabled={sending || strokes.length === 0 || size === undefined}
          onClick={() => void send()}
        >
          マスクを送る
        </Button>
        <Button className="h-7 px-2 text-xs" onClick={() => setOpen(false)}>
          閉じる
        </Button>
      </div>
      <p className="text-xs">
        白く塗った所を、次の回の inpaint で描き直す。マスクは1回使うか、新しいマスクを送ると切れる。
      </p>
      {sent && <OkNote>送った。次の回の境目から inpaint に使える。</OkNote>}
      {error !== undefined && <ErrorNote>送れない: {error}</ErrorNote>}
    </div>
  );
}
