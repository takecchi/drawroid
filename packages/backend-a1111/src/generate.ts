import {
  generationResponseSchema,
  img2imgFields,
  readGenerationResponse,
  resolveImages,
} from '@drawroid/backend-sdapi';
import {
  BackendError,
  type GenerationImages,
  type GenerationRequest,
  type GenerationResult,
} from '@drawroid/core';

import type { A1111Client } from './client.js';
import { buildA1111Payload } from './txt2img.js';

/**
 * 中立の要求を、A1111 の txt2img か img2img の1回の呼び出しに写す。
 */
export async function generateWithA1111(
  client: A1111Client,
  req: GenerationRequest,
  options: { signal: AbortSignal; timeoutMs: number; images?: GenerationImages },
): Promise<GenerationResult> {
  const { signal } = options;
  // 断る: probe で ControlNet を「使えない」と報告しているのに、要求に入っていたら、黙って捨てずに理由を返す
  if (req.controlnet.length > 0) {
    throw new BackendError('failed', 'drawroid の A1111 のアダプタはまだ ControlNet を扱わない');
  }
  const images = resolveImages(req, options.images ?? new Map());
  const fromImage = req.img2img !== undefined || req.inpaint !== undefined;
  // 断る: A1111 の img2img の API には Hires. fix の欄が無く、送っても黙って無視されるため（modules/processing.py）
  if (fromImage && req.hiresFix !== undefined) {
    throw new BackendError('failed', 'A1111 の img2img・inpaint は Hires. fix と同時に使えない');
  }

  const payload = {
    ...(await buildA1111Payload(client, req, signal)),
    ...img2imgFields(req, images),
  };
  const endpoint = fromImage ? 'img2img' : 'txt2img';
  const res = await client.postJson(`/sdapi/v1/${endpoint}`, payload, generationResponseSchema, {
    signal,
    timeoutMs: options.timeoutMs,
  });
  return readGenerationResponse(res, req.batchSize, { endpoint, product: client.product });
}
