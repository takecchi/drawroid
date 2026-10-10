import type { GenerationProgress } from '@drawroid/core';
import { z } from 'zod';

import type { SdapiClient } from './client.js';
import { assertImageWithinLimit } from './response.js';

// 使う欄だけを見る。知らない欄が増えても落とさない（state には、ほかの欄もある）
const progressResponseSchema = z.looseObject({
  progress: z.number().nullish(),
  eta_relative: z.number().nullish(),
  state: z
    .looseObject({
      job_count: z.number().nullish(),
      sampling_step: z.number().nullish(),
      sampling_steps: z.number().nullish(),
    })
    .nullish(),
  current_image: z.string().nullish(),
});

type Preview = NonNullable<GenerationProgress['preview']>;

/**
 * Forge・A1111 の GET /sdapi/v1/progress を読む。何も走っていなければ undefined。
 * 失敗の分類は SdapiClient のまま（繋がらなければ unreachable など）。
 */
export async function readProgress(
  client: SdapiClient,
  signal: AbortSignal,
  options: { includePreview?: boolean } = {},
): Promise<GenerationProgress | undefined> {
  const includePreview = options.includePreview === true;
  const res = await client.getJson(
    `/sdapi/v1/progress?skip_current_image=${String(!includePreview)}`,
    progressResponseSchema,
    { signal },
  );
  // job_count が 0 のとき、バックエンドは進み 0 を返す。走っていないのと区別できないので、ここで返さない
  if ((res.state?.job_count ?? 0) === 0) return undefined;

  const progress: GenerationProgress = {
    fraction: Math.min(1, Math.max(0, res.progress ?? 0)),
    step: res.state?.sampling_step ?? null,
    steps: res.state?.sampling_steps ?? null,
    etaSeconds: res.eta_relative != null && res.eta_relative > 0 ? res.eta_relative : null,
  };
  if (includePreview && res.current_image) {
    assertImageWithinLimit(res.current_image, '途中の画像', client.product);
    const preview = decodePreview(res.current_image);
    if (preview !== undefined) progress.preview = preview;
  }
  return progress;
}

function decodePreview(base64: string): Preview | undefined {
  const data = new Uint8Array(Buffer.from(base64, 'base64'));
  const mediaType = sniffMediaType(data);
  return mediaType === undefined ? undefined : { data, mediaType };
}

function sniffMediaType(b: Uint8Array): Preview['mediaType'] | undefined {
  if (startsWith(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // RIFF....WEBP
  if (startsWith(b, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, 8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }
  return undefined;
}

function startsWith(b: Uint8Array, offset: number, bytes: number[]): boolean {
  return bytes.every((v, i) => b[offset + i] === v);
}
