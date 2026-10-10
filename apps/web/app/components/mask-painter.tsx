import { addMask, isApiError } from '@drawroid/swr';
import { Button, CheckboxField, ErrorNote, Field, Input, OkNote } from '@drawroid/ui';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

import { encodeMaskPng } from '../lib/mask-png';
import { drawMask, toImagePoint, type MaskSize, type Stroke } from '../lib/mask-strokes';

const DEFAULT_RADIUS = 32;

/** マスクを塗る先の画像1枚 */
export interface MaskTarget {
  jobId: string;
  iteration: number;
  index: number;
}

/** 塗っている間の状態。塗る面（MaskSurface）と道具（MaskTools）を別の場所に置けるように、状態は1つにまとめて渡す */
export interface MaskPainting {
  size: MaskSize | undefined;
  setSize: (size: MaskSize) => void;
  strokes: Stroke[];
  setStrokes: (update: (current: Stroke[]) => Stroke[]) => void;
  radius: number;
  setRadius: (radius: number) => void;
  erase: boolean;
  setErase: (erase: boolean) => void;
  sending: boolean;
  error: string | undefined;
  sent: boolean;
  setSent: (sent: boolean) => void;
  send: () => Promise<void>;
}

/**
 * 塗っている間の状態を持つ。塗る先が変わったら、塗りかけと読んだ大きさを捨てる: 別の画像の上に、前の画像の筆が残らないように
 */
export function useMaskPainting(target: MaskTarget | undefined): MaskPainting {
  const identity =
    target === undefined ? '' : `${target.jobId}:${target.iteration}-${target.index}`;
  const [owner, setOwner] = useState(identity);
  const [size, setSize] = useState<MaskSize | undefined>();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [erase, setErase] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  if (owner !== identity) {
    setOwner(identity);
    setSize(undefined);
    setStrokes([]);
    setError(undefined);
    setSent(false);
  }

  async function send() {
    if (size === undefined || target === undefined) return;
    setSending(true);
    setError(undefined);
    try {
      const png = await encodeMaskPng(strokes, size);
      await addMask(target.jobId, { iteration: target.iteration, index: target.index }, png);
      setStrokes([]);
      setSent(true);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setSending(false);
    }
  }

  return {
    size,
    setSize,
    strokes,
    setStrokes,
    radius,
    setRadius,
    erase,
    setErase,
    sending,
    error,
    sent,
    setSent,
    send,
  };
}

/**
 * 画像の上に canvas を重ねた、塗る面。`loading` を渡すと、画像が読み込まれるまで面を出さずに、それを出す
 * （大きく見る窓では、塗り始めてから原寸を読み込むので、読み込む前の面に塗れないように）
 */
export function MaskSurface({
  src,
  alt,
  painting,
  imageClassName = 'block max-w-full',
  loading,
}: {
  src: string;
  alt: string;
  painting: MaskPainting;
  imageClassName?: string;
  loading?: ReactNode;
}) {
  const { size, setSize, strokes, setStrokes, radius, erase, setSent } = painting;
  const [drawing, setDrawing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 画面の canvas にも、送るものと同じマスクを描く: 見えている塗りと送るマスクがずれないように
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (size === undefined || context == null) return;
    drawMask(context, strokes, size);
  }, [strokes, size]);

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

  const waiting = loading !== undefined && size === undefined;
  return (
    <>
      {waiting && loading}
      <div className={waiting ? 'hidden' : 'relative inline-block max-w-full'}>
        <img
          src={src}
          alt={alt}
          className={imageClassName}
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
    </>
  );
}

/** 塗る道具（筆の太さ・消しゴム・戻す・送る）と、送ったか・送れなかったかの知らせ */
export function MaskTools({
  painting,
  onClose,
  closeLabel = '閉じる',
}: {
  painting: MaskPainting;
  onClose: () => void;
  closeLabel?: string;
}) {
  const { size, strokes, setStrokes, radius, setRadius, erase, setErase, sending } = painting;
  // 道具が出たら、最初の道具（筆の太さ）へフォーカスを移す: 押した「マスクを塗る」は消えるので、
  // 移さないとフォーカスが窓（またはページ）そのものに落ち、キーボードの人がどこにいるか分からなくなるため
  const toolsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    toolsRef.current?.querySelector<HTMLInputElement>('input[type="number"]')?.focus();
  }, []);
  return (
    <>
      <p className="text-xs text-muted-foreground">
        キーボードでは塗れない（マウス・タッチ・ペンで塗る）。
      </p>
      <div ref={toolsRef} className="flex flex-wrap items-end gap-2">
        <Field label="筆の太さ（px）">
          <Input
            type="number"
            min={1}
            max={512}
            value={radius}
            onChange={(event) => setRadius(Math.max(1, Number(event.target.value) || 1))}
            className="h-11 w-20 md:h-7"
          />
        </Field>
        <CheckboxField
          label="消しゴム"
          checked={erase}
          onChange={(event) => setErase(event.target.checked)}
          className="pb-1"
        />
        <Button
          size="sm"
          disabled={strokes.length === 0}
          onClick={() => setStrokes((current) => current.slice(0, -1))}
        >
          ひとつ戻す
        </Button>
        <Button size="sm" disabled={strokes.length === 0} onClick={() => setStrokes(() => [])}>
          全部消す
        </Button>
        <Button
          size="sm"
          disabled={sending || strokes.length === 0 || size === undefined}
          onClick={() => void painting.send()}
        >
          マスクを送る
        </Button>
        <Button size="sm" onClick={onClose}>
          {closeLabel}
        </Button>
      </div>
      <p className="text-xs">
        白く塗った所を、次の回で描き直す。マスクは1回使うか、新しいマスクを送ると切れる。
      </p>
      {painting.sent && <OkNote>マスクを送った。次の回で描き直す。</OkNote>}
      {painting.error !== undefined && <ErrorNote>送れない: {painting.error}</ErrorNote>}
    </>
  );
}

/**
 * 回の画像1枚の上に inpaint のマスクを塗り、口出しとして送る。白く塗った所が、次の回の inpaint で描き直される。
 * ジョブの詳細の画像の枡に置く（大きく見る窓では、塗る面と道具を分けて置く）
 */
export function MaskPainter({
  jobId,
  image,
}: {
  jobId: string;
  image: { iteration: number; index: number; url: string };
}) {
  const [open, setOpen] = useState(false);
  const painting = useMaskPainting({ jobId, iteration: image.iteration, index: image.index });

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        マスクを塗る
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <MaskSurface
        src={image.url}
        alt={`${image.iteration} 回目の画像 ${image.index + 1} 番`}
        painting={painting}
      />
      <MaskTools painting={painting} onClose={() => setOpen(false)} />
    </div>
  );
}
