import { z } from 'zod';

import type { SdapiClient } from './client.js';

/** 走っている生成を、バックエンドの側で止めさせる。何も走っていなくても失敗しない */
export async function interruptGeneration(client: SdapiClient): Promise<void> {
  await client.postJson('/sdapi/v1/interrupt', {}, z.unknown());
}
