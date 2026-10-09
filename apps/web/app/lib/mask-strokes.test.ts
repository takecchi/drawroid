import { describe, expect, it } from 'vitest';

import { drawMask, toImagePoint, type MaskCanvas, type Stroke } from './mask-strokes';

const size = { width: 1024, height: 768 };
// 画面には半分の大きさで出ている
const box = { left: 100, top: 50, width: 512, height: 384 };

describe('toImagePoint', () => {
  it('turns a point on the screen into a point on the original image', () => {
    expect(toImagePoint({ x: 100 + 256, y: 50 + 192 }, box, size)).toEqual({ x: 512, y: 384 });
  });

  it('keeps a point dragged off the image on its edge', () => {
    expect(toImagePoint({ x: 0, y: 1000 }, box, size)).toEqual({ x: 0, y: 768 });
  });

  it('gives nothing while the image has no size on the screen yet', () => {
    expect(toImagePoint({ x: 10, y: 10 }, { ...box, width: 0, height: 0 }, size)).toBeUndefined();
  });
});

function recordingCanvas() {
  const ops: unknown[] = [];
  const canvas: MaskCanvas = {
    set fillStyle(value: string) {
      ops.push(['fillStyle', value]);
    },
    set strokeStyle(value: string) {
      ops.push(['strokeStyle', value]);
    },
    set lineWidth(value: number) {
      ops.push(['lineWidth', value]);
    },
    set lineCap(value: CanvasLineCap) {
      ops.push(['lineCap', value]);
    },
    set lineJoin(value: CanvasLineJoin) {
      ops.push(['lineJoin', value]);
    },
    fillRect: (...args) => ops.push(['fillRect', ...args]),
    beginPath: () => ops.push(['beginPath']),
    moveTo: (...args) => ops.push(['moveTo', ...args]),
    lineTo: (...args) => ops.push(['lineTo', ...args]),
    stroke: () => ops.push(['stroke']),
    arc: (...args) => ops.push(['arc', ...args]),
    fill: () => ops.push(['fill']),
  };
  return { canvas, ops };
}

describe('drawMask', () => {
  it('fills the whole image black, so only what was painted is redrawn', () => {
    const { canvas, ops } = recordingCanvas();

    drawMask(canvas, [], size);

    expect(ops).toEqual([
      ['fillStyle', '#000'],
      ['fillRect', 0, 0, 1024, 768],
    ]);
  });

  it('paints a stroke white and an erased stroke black, in the order they were drawn', () => {
    const { canvas, ops } = recordingCanvas();
    const strokes: Stroke[] = [
      {
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        radius: 8,
        erase: false,
      },
      {
        points: [
          { x: 30, y: 40 },
          { x: 50, y: 60 },
        ],
        radius: 4,
        erase: true,
      },
    ];

    drawMask(canvas, strokes, size);

    const paint = ops.findIndex((op) => JSON.stringify(op) === '["strokeStyle","#fff"]');
    const erase = ops.findIndex((op) => JSON.stringify(op) === '["strokeStyle","#000"]');
    expect(paint).toBeGreaterThan(-1);
    expect(erase).toBeGreaterThan(paint);
    expect(ops).toContainEqual(['lineWidth', 16]);
    expect(ops).toContainEqual(['lineWidth', 8]);
    expect(ops).toContainEqual(['moveTo', 10, 20]);
    expect(ops).toContainEqual(['lineTo', 30, 40]);
  });

  it('paints a single click as a dot of the brush size', () => {
    const { canvas, ops } = recordingCanvas();

    drawMask(canvas, [{ points: [{ x: 5, y: 6 }], radius: 12, erase: false }], size);

    expect(ops).toContainEqual(['fillStyle', '#fff']);
    expect(ops).toContainEqual(['arc', 5, 6, 12, 0, Math.PI * 2]);
  });
});
