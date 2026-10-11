import { BackendError } from '@drawroid/core';
import { z } from 'zod';

import type { SdapiClient } from './client.js';

const sdModelsSchema = z.array(z.object({ title: z.string(), model_name: z.string() }));

/**
 * チェックポイントの名前を、バックエンドの一覧の title に引き当てる。title の完全一致を先に見て、
 * 無ければ model_name の一致を見る。無いか、model_name が複数に当たるときは失敗させる。
 */
// Forge・A1111 は見つからないチェックポイントの指定を黙って捨て、いま読み込まれているモデルで生成する
// （modules/processing.py の process_images）。先に引き当てて、違うモデルで描かれるのを防ぐ
export async function resolveCheckpoint(
  client: SdapiClient,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  const models = await client.getJson('/sdapi/v1/sd-models', sdModelsSchema, { signal });
  const exact = models.find((m) => m.title === name);
  if (exact !== undefined) return exact.title;
  // 最初の一致に決めない: 同じ名前のファイルが別の階層にあると、指定した覚えのないモデルで描かれるため
  const byModelName = models.filter((m) => m.model_name === name);
  const [only, ...others] = byModelName;
  if (only === undefined) {
    throw new BackendError('failed', `チェックポイント ${name} が ${client.product} に無い`);
  }
  if (others.length > 0) {
    throw new BackendError(
      'failed',
      `チェックポイント ${name} が ${client.product} に複数ある。title で指定する`,
    );
  }
  return only.title;
}
