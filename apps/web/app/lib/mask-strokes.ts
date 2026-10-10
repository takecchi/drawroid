/** 画像の元の大きさの上の座標（px） */
export interface Point {
  x: number;
  y: number;
}

/** 押してから離すまでの1筆。radius は元の画像の上の px。erase は塗った所を消す */
export interface Stroke {
  points: Point[];
  radius: number;
  erase: boolean;
}

export interface MaskSize {
  width: number;
  height: number;
}

/** 描く先。canvas の 2D の描画先のうち、マスクを描くのに使う所だけ（試験で記録する偽物に差し替えられるように） */
export type MaskCanvas = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'arc'
  | 'fill'
>;

/**
 * 画面の上の位置を、画像の元の大きさの上の座標に直す。画像の外へはみ出した所は端に寄せる。
 * 画面の上でまだ大きさが決まっていなければ（読み込み前など）undefined を返す。
 */
export function toImagePoint(
  client: Point,
  box: { left: number; top: number; width: number; height: number },
  size: MaskSize,
): Point | undefined {
  if (box.width <= 0 || box.height <= 0) return undefined;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  return {
    x: clamp(((client.x - box.left) / box.width) * size.width, size.width),
    y: clamp(((client.y - box.top) / box.height) * size.height, size.height),
  };
}

/**
 * 塗った筆をマスクとして描く。黒で埋めてから、塗った所を白、消した所を黒で、描いた順に重ねる。
 */
// 色は白と黒だけを指定する: inpaint は白い所を描き直すため。ただし筆の縁は canvas が滑らかに描くので、
// 縁には白と黒の間の灰色が混じる（白黒の2色だけにはならない）
export function drawMask(canvas: MaskCanvas, strokes: readonly Stroke[], size: MaskSize): void {
  canvas.fillStyle = '#000';
  canvas.fillRect(0, 0, size.width, size.height);
  for (const stroke of strokes) {
    const color = stroke.erase ? '#000' : '#fff';
    const [first, ...rest] = stroke.points;
    if (first === undefined) continue;
    if (rest.length === 0) {
      canvas.fillStyle = color;
      canvas.beginPath();
      canvas.arc(first.x, first.y, stroke.radius, 0, Math.PI * 2);
      canvas.fill();
      continue;
    }
    canvas.strokeStyle = color;
    canvas.lineWidth = stroke.radius * 2;
    canvas.lineCap = 'round';
    canvas.lineJoin = 'round';
    canvas.beginPath();
    canvas.moveTo(first.x, first.y);
    for (const point of rest) canvas.lineTo(point.x, point.y);
    canvas.stroke();
  }
}
