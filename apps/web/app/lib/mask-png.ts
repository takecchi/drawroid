import { drawMask, type MaskSize, type Stroke } from './mask-strokes';

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
