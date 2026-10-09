import { BackendError } from '@drawroid/core';
import { z } from 'zod';

import type { SdapiClient } from './client.js';

const sdModelsSchema = z.array(z.object({ title: z.string(), model_name: z.string() }));

/**
 * チェックポイントの名前を、バックエンドの一覧の title に引き当てる。無ければ失敗させる。
 */
// Forge・A1111 は見つからないチェックポイントの指定を黙って捨て、いま読み込まれているモデルで生成する
// （modules/processing.py の process_images）。先に引き当てて、違うモデルで描かれるのを防ぐ
export async function resolveCheckpoint(
  client: SdapiClient,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  const models = await client.getJson('/sdapi/v1/sd-models', sdModelsSchema, { signal });
  const found = models.find((m) => m.title === name || m.model_name === name);
  if (found === undefined) {
    throw new BackendError('failed', `チェックポイント ${name} が ${client.product} に無い`);
  }
  return found.title;
}
