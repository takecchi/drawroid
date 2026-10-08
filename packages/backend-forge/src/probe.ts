import type { BackendCapabilities } from '@drawroid/core';
import { z } from 'zod';

import type { ForgeClient } from './client.js';

// 軽い GET で「繋がるか・API があるか」を見る。cmd-flags は小さく、拡張に依らず必ずある
const cmdFlagsSchema = z.record(z.string(), z.unknown());

const NOT_YET_SUPPORTED = 'drawroid の Forge アダプタがまだ対応していない（M4 で対応する）';

export async function probeForge(
  client: ForgeClient,
  signal?: AbortSignal,
): Promise<BackendCapabilities> {
  await client.getJson('/sdapi/v1/cmd-flags', cmdFlagsSchema, signal);
  return {
    unavailable: [
      { feature: 'img2img', reason: NOT_YET_SUPPORTED },
      { feature: 'inpaint', reason: NOT_YET_SUPPORTED },
      { feature: 'controlnet', reason: NOT_YET_SUPPORTED },
    ],
  };
}
