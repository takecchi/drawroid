import type { REFERENCE_MEDIA_TYPES } from '@drawroid/core';
import sharp, { type Metadata } from 'sharp';

/** 受け付ける画像の幅・高さの上限（px）。最終の画像の大きさの上限と揃える */
export const MAX_IMAGE_EDGE = 8192;

const FORMAT_OF_MEDIA_TYPE: Record<(typeof REFERENCE_MEDIA_TYPES)[number], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

/**
 * 受けた画像が、読めて、宣言した形式で、大きすぎないかを確かめる。問題が無ければ undefined、あれば人に見せる理由。
 * 同期の zod の検証には入れず、画像を受ける口のハンドラから呼ぶ（sharp が非同期のため）。
 */
// limitInputPixels を外す: 大きすぎる画像が sharp の既定の画素数の上限で「読めない」と言われ、「大きすぎる」という本当の理由が隠れるため。
// 外しても安全なのは、ここは画素を展開せず、ヘッダの大きさだけを読むため
export async function imageProblem(
  bytes: Uint8Array,
  mediaType: keyof typeof FORMAT_OF_MEDIA_TYPE,
): Promise<string | undefined> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    return '画像として読めない';
  }
  if (metadata.format !== FORMAT_OF_MEDIA_TYPE[mediaType]) {
    return `${mediaType} の画像ではない（中身は ${metadata.format ?? '不明'}）`;
  }
  const { width = 0, height = 0 } = metadata;
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    return `画像が大きすぎる（${width}×${height} px。幅・高さとも ${MAX_IMAGE_EDGE} px まで）`;
  }
  return undefined;
}
