import { addMask, isApiError } from '@drawroid/swr';
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
      <button type="button" onClick={() => setOpen(true)}>
        マスクを塗る
      </button>
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
    <div>
      <div style={{ position: 'relative', display: 'inline-block', maxWidth: 640 }}>
        <img
          src={image.url}
          alt={alt}
          style={{ display: 'block', maxWidth: '100%' }}
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
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            mixBlendMode: 'screen',
            opacity: 0.6,
            touchAction: 'none',
            cursor: 'crosshair',
          }}
          onPointerDown={start}
          onPointerMove={extend}
          onPointerUp={() => setDrawing(false)}
          onPointerLeave={() => setDrawing(false)}
        />
      </div>
      <div>
        <label>
          筆の太さ（px）{' '}
          <input
            type="number"
            min={1}
            max={512}
            value={radius}
            onChange={(event) => setRadius(Math.max(1, Number(event.target.value) || 1))}
            style={{ width: 64 }}
          />
        </label>{' '}
        <label>
          <input
            type="checkbox"
            checked={erase}
            onChange={(event) => setErase(event.target.checked)}
          />
          消しゴム
        </label>{' '}
        <button
          type="button"
          disabled={strokes.length === 0}
          onClick={() => setStrokes((current) => current.slice(0, -1))}
        >
          ひとつ戻す
        </button>{' '}
        <button type="button" disabled={strokes.length === 0} onClick={() => setStrokes([])}>
          全部消す
        </button>{' '}
        <button
          type="button"
          disabled={sending || strokes.length === 0 || size === undefined}
          onClick={() => void send()}
        >
          マスクを送る
        </button>{' '}
        <button type="button" onClick={() => setOpen(false)}>
          閉じる
        </button>
      </div>
      <p style={{ margin: '4px 0' }}>
        白く塗った所を、次の回の inpaint で描き直す。マスクは1回使うか、新しいマスクを送ると切れる。
      </p>
      {sent && <p>送った。次の回の境目から inpaint に使える。</p>}
      {error !== undefined && <p role="alert">送れない: {error}</p>}
    </div>
  );
}
