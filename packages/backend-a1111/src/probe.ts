import type { BackendCapabilities } from '@drawroid/core';
import { z } from 'zod';

import type { A1111Client } from './client.js';
import { CONTROLNET_SETTINGS_MISSING, countControlNetUnits, hasControlNet } from './controlnet.js';

// 軽い GET で「繋がるか・API があるか」を見る。cmd-flags は小さく、拡張に依らず必ずある
const cmdFlagsSchema = z.record(z.string(), z.unknown());

const CONTROLNET_NOT_INSTALLED = 'A1111 に ControlNet の拡張（sd-webui-controlnet）が入っていない';

export async function probeA1111(
  client: A1111Client,
  signal?: AbortSignal,
): Promise<BackendCapabilities> {
  await client.getJson('/sdapi/v1/cmd-flags', cmdFlagsSchema, { signal });
  // img2img・inpaint は A1111 本体の /sdapi/v1/img2img なので、拡張に依らず使える。Hires. fix も本体にある
  if (!(await hasControlNet(client, signal))) {
    return { unavailable: [{ feature: 'controlnet', reason: CONTROLNET_NOT_INSTALLED }] };
  }
  const units = await countControlNetUnits(client, signal);
  if (units === undefined) {
    return { unavailable: [{ feature: 'controlnet', reason: CONTROLNET_SETTINGS_MISSING }] };
  }
  return { unavailable: [], limits: { controlnetUnits: units } };
}
