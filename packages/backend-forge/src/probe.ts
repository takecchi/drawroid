import { type BackendCapabilities, BackendError } from '@drawroid/core';
import { z } from 'zod';

import type { ForgeClient } from './client.js';

// 軽い GET で「繋がるか・API があるか」を見る。cmd-flags は小さく、拡張に依らず必ずある
const cmdFlagsSchema = z.record(z.string(), z.unknown());
// alwayson のスクリプトも名前（title の小文字）で載る（modules/scripts.py）
const scriptsSchema = z.object({ txt2img: z.array(z.string()), img2img: z.array(z.string()) });
const scriptInfoSchema = z.array(
  z.looseObject({
    name: z.string().nullish(),
    is_img2img: z.boolean(),
    args: z.array(z.unknown()),
  }),
);

/** Forge 内蔵の ControlNet（extensions-builtin/sd_forge_controlnet）がスクリプトとして載る名前 */
export const FORGE_CONTROLNET_SCRIPT = 'controlnet';

// Forge の設定 control_net_unit_count の既定値（sd_forge_controlnet/scripts/controlnet.py）
export const DEFAULT_CONTROLNET_UNITS = 3;

const CONTROLNET_MISSING =
  'Forge に ControlNet（内蔵の sd_forge_controlnet）が読み込まれていない。Forge の拡張の設定で有効になっているかを確かめる';

export async function probeForge(
  client: ForgeClient,
  signal?: AbortSignal,
): Promise<BackendCapabilities> {
  await client.getJson('/sdapi/v1/cmd-flags', cmdFlagsSchema, { signal });
  // img2img・inpaint は Forge 本体の /sdapi/v1/img2img なので、拡張に依らず使える
  if (!(await hasControlNet(client, signal))) {
    return { unavailable: [{ feature: 'controlnet', reason: CONTROLNET_MISSING }] };
  }
  return {
    unavailable: [],
    limits: { controlnetUnits: await countControlNetUnits(client, signal) },
  };
}

// /sdapi/v1/extensions では見ない: 内蔵の拡張は remote が無いので、その一覧に載らないため（modules/extensions.py）
export async function hasControlNet(client: ForgeClient, signal?: AbortSignal): Promise<boolean> {
  const scripts = await client.getJson('/sdapi/v1/scripts', scriptsSchema, { signal });
  return (
    scripts.txt2img.includes(FORGE_CONTROLNET_SCRIPT) &&
    scripts.img2img.includes(FORGE_CONTROLNET_SCRIPT)
  );
}

/**
 * 1回の生成に載せられる ControlNet のユニットの数。
 */
// 実機では未確認: script-info の ControlNet の args の数がユニットの数になる、というのはソースを読んだうえでの推測である。
// Forge の ControlNet の ui() はユニットごとに1つの部品を返し、script-info はその部品を1つずつ args に並べる
// （sd_forge_controlnet/scripts/controlnet.py の ui、modules/scripts.py の api_info）。
// 数えられないときの既定の 3 も、Forge の設定 control_net_unit_count の既定値を使った推測で、実機では未確認。
// 設定を変えた Forge では 3 が合わず、それより多く送った分は Forge が黙って捨てる（modules/api/api.py の init_script_args）
export async function countControlNetUnits(
  client: ForgeClient,
  signal?: AbortSignal,
): Promise<number> {
  let infos: z.infer<typeof scriptInfoSchema>;
  try {
    infos = await client.getJson('/sdapi/v1/script-info', scriptInfoSchema, { signal });
  } catch (error) {
    if (error instanceof BackendError && error.kind === 'bad_response') {
      return DEFAULT_CONTROLNET_UNITS;
    }
    throw error;
  }
  const counts = infos
    .filter((info) => info.name === FORGE_CONTROLNET_SCRIPT)
    .map((info) => info.args.length);
  if (counts.length === 0 || counts.some((n) => n === 0)) return DEFAULT_CONTROLNET_UNITS;
  // txt2img と img2img で数が違えば、少ない方に合わせる。多い方に合わせると、片方で黙って捨てられる
  return Math.min(...counts);
}
