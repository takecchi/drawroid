import { BackendError, type GenerationResult } from '@drawroid/core';
import { z } from 'zod';

import { MAX_IMAGE_BYTES } from './client.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** base64 を戻したときのバイト数。戻す前に大きさを確かめるために使う */
export function decodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** 画像1枚の大きさが上限の内か。超えていれば、何の画像かを言って投げる */
export function assertImageWithinLimit(base64: string, what: string, product: string): void {
  if (decodedLength(base64) > MAX_IMAGE_BYTES) {
    throw new BackendError(
      'bad_response',
      `${what}が大きすぎる（1枚 ${MAX_IMAGE_BYTES / (1024 * 1024)} MB まで）。${product} の設定で、画像の大きさを確かめる`,
    );
  }
}

// info は JSON の文字列で返る。使う欄だけを見る
const generationInfoSchema = z.looseObject({
  seed: z.number().nullish(),
  all_seeds: z.array(z.number()).nullish(),
  infotexts: z.array(z.string()).nullish(),
  index_of_first_image: z.number().int().nonnegative().nullish(),
});

// txt2img と img2img は同じ形で返す（modules/api/models.py の TextToImageResponse・ImageToImageResponse）
export const generationResponseSchema = z.object({
  images: z.array(z.string()),
  info: z.string(),
});

/**
 * txt2img・img2img の応答から、生成した画像を枚数ぶんだけ取り出す。
 */
export function readGenerationResponse(
  res: z.infer<typeof generationResponseSchema>,
  batchSize: number,
  options: { endpoint: 'txt2img' | 'img2img'; product: string },
): GenerationResult {
  const { endpoint, product } = options;
  let info: z.infer<typeof generationInfoSchema>;
  try {
    info = generationInfoSchema.parse(JSON.parse(res.info));
  } catch (error) {
    throw new BackendError('bad_response', `${product} の ${endpoint} の info が読めない`, {
      cause: error,
    });
  }
  // バッチが2枚以上のとき、格子画像が先頭に足されることがある。index_of_first_image が個々の画像の始まりを指す。
  // 枚数ぶんだけ切り出す: ControlNet の検出マップなど、生成した画像でないものが末尾に付くことがあるため（modules/api/api.py）
  const first = info.index_of_first_image ?? 0;
  const encoded = res.images.slice(first, first + batchSize);
  if (encoded.length !== batchSize) {
    throw new BackendError(
      'bad_response',
      // interrupt されても失敗を返さず、そこまでに描けた画像だけを返す
      `${endpoint} が ${batchSize} 枚を返すはずが ${encoded.length} 枚だった。${product} の画面などで生成が中断された可能性がある`,
    );
  }
  const images = encoded.map((b64, i) => {
    // 戻す前に確かめる: 戻してから測ると、大きすぎる画像の分のメモリを先に使ってしまうため
    assertImageWithinLimit(b64, `${endpoint} の画像`, product);
    const png = Uint8Array.from(Buffer.from(b64, 'base64'));
    if (!PNG_SIGNATURE.every((byte, j) => png[j] === byte)) {
      throw new BackendError(
        'bad_response',
        `${endpoint} の画像が PNG ではない。${product} の設定の画像形式（samples_format）を png にする`,
      );
    }
    return {
      png,
      seed: info.all_seeds?.[i] ?? (i === 0 ? (info.seed ?? null) : null),
      metadata: { infotext: info.infotexts?.[first + i] ?? null },
    };
  });
  return { images, metadata: { info } };
}
