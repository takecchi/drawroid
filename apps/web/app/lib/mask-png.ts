import { drawMask, type MaskSize, type Stroke } from './mask-strokes';

// サーバ（core の job/types.ts。api もそれを使う）と同じ値。同じであることは試験で縛る。
// api を runtime で import しない: サーバ側の依存（zod の transform や Buffer）をブラウザの成果物へ引き込まないため
export const MAX_MASK_BYTES = 8 * 1024 * 1024;

/** base64 を戻したあとのバイト数 */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** マスクを送れない理由。送れるときは undefined */
// 上限だけを言わない: マスクの PNG は、塗った広さよりも塗りの縁の長さで大きくなる（縁には灰色が混じり、縮みにくい）。
// 細い筆で細かく塗るほど大きくなるので、断られた人が何を変えれば通るかを読み取れるように
export function maskPngProblem(png: string): string | undefined {
  const bytes = decodedBytes(png);
  if (bytes <= MAX_MASK_BYTES) return undefined;
  // 切り上げる: 少しだけ超えたときに、上限と同じ値（8.0MB）を出さないように
  const megabytes = (Math.ceil((bytes / 1024 / 1024) * 10) / 10).toFixed(1);
  return `マスクが ${MAX_MASK_BYTES / 1024 / 1024}MB を超えている（${megabytes}MB）。細い筆で細かく塗った所ほど大きくなるので、太い筆でまとめて塗り直すか、「ひとつ戻す」で筆を減らす`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 塗った筆を、画像の元の大きさの PNG にして base64 で返す。
 */
// 画面に出している canvas から作らない: 画面の canvas は表示の大きさに合わせて縮むことがあり、元の画像と大きさがずれるため
export async function encodeMaskPng(strokes: readonly Stroke[], size: MaskSize): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('この環境では canvas に描けない');
  drawMask(context, strokes, size);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('マスクを PNG にできなかった');
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}
