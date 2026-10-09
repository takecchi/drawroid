import type { BackendCapabilities } from '@drawroid/core';
import { z } from 'zod';

import type { A1111Client } from './client.js';

// 軽い GET で「繋がるか・API があるか」を見る。cmd-flags は小さく、拡張に依らず必ずある
const cmdFlagsSchema = z.record(z.string(), z.unknown());
// スクリプトは名前（title の小文字）で載る（modules/scripts.py）
const scriptsSchema = z.object({ txt2img: z.array(z.string()), img2img: z.array(z.string()) });

/** ControlNet の拡張（Mikubill/sd-webui-controlnet）がスクリプトとして載る名前。拡張の title は "ControlNet" */
export const A1111_CONTROLNET_SCRIPT = 'controlnet';

const CONTROLNET_NOT_INSTALLED = 'A1111 に ControlNet の拡張（sd-webui-controlnet）が入っていない';
const CONTROLNET_NOT_SUPPORTED =
  'A1111 に ControlNet の拡張は入っているが、drawroid の A1111 のアダプタはまだ ControlNet を扱わない';

export async function probeA1111(
  client: A1111Client,
  signal?: AbortSignal,
): Promise<BackendCapabilities> {
  await client.getJson('/sdapi/v1/cmd-flags', cmdFlagsSchema, { signal });
  // img2img・inpaint は A1111 本体の /sdapi/v1/img2img なので、拡張に依らず使える。Hires. fix も本体にある
  const scripts = await client.getJson('/sdapi/v1/scripts', scriptsSchema, { signal });
  const installed =
    scripts.txt2img.includes(A1111_CONTROLNET_SCRIPT) &&
    scripts.img2img.includes(A1111_CONTROLNET_SCRIPT);
  return {
    unavailable: [
      {
        feature: 'controlnet',
        reason: installed ? CONTROLNET_NOT_SUPPORTED : CONTROLNET_NOT_INSTALLED,
      },
    ],
  };
}
