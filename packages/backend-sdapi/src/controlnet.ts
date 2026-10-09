import { BackendError, type ControlNetUnit, type ResizeMode } from '@drawroid/core';
import { z } from 'zod';

import type { SdapiClient } from './client.js';
import type { ResolvedImages } from './images.js';

// 文字列で渡す: Forge の ControlNet は control_mode を文字列で比べており、数を渡すと黙って Balanced になるため
// （sd_forge_controlnet/scripts/controlnet.py）。A1111 の拡張も同じ文字列を受ける（sd-webui-controlnet の scripts/enums.py:247-255）
const CONTROL_MODE: Record<ControlNetUnit['controlMode'], string> = {
  balanced: 'Balanced',
  prompt: 'My prompt is more important',
  controlnet: 'ControlNet is more important',
};

// A1111 の拡張も同じ文字列（sd-webui-controlnet の scripts/enums.py:262-270）
const RESIZE_MODE: Record<ResizeMode, string> = {
  stretch: 'Just Resize',
  crop: 'Crop and Resize',
  fill: 'Resize and Fill',
};

const modelListSchema = z.object({ model_list: z.array(z.string()) });
const moduleListSchema = z.object({ module_list: z.array(z.string()) });

/**
 * /controlnet/model_list の名前（"名前 [ハッシュ]"）。ControlNet が無ければ、この API 自体が無いので undefined。
 */
export async function fetchControlNetModels(
  client: SdapiClient,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  return (await getIfPresent(client, '/controlnet/model_list', modelListSchema, signal))
    ?.model_list;
}

/** /controlnet/module_list の前処理の名前。ControlNet が無ければ undefined */
export async function fetchControlNetModules(
  client: SdapiClient,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  return (await getIfPresent(client, '/controlnet/module_list', moduleListSchema, signal))
    ?.module_list;
}

async function getIfPresent<S extends z.ZodType>(
  client: SdapiClient,
  path: string,
  schema: S,
  signal: AbortSignal | undefined,
): Promise<z.infer<S> | undefined> {
  try {
    return await client.getJson(path, schema, { signal });
  } catch (error) {
    if (error instanceof BackendError && error.kind === 'not_found') return undefined;
    throw error;
  }
}

export function withoutHash(name: string): string {
  return name.replace(/ \[[0-9a-f]+\]$/i, '');
}

export interface ControlNetArgsOptions {
  units: readonly ControlNetUnit[];
  images: ResolvedImages;
  /** 1回の生成に載せられるユニットの数 */
  limit: number;
  /** モデルの名前（"名前 [ハッシュ]"）の一覧 */
  models: readonly string[];
  /** 前処理の名前の一覧。前処理を指定したユニットが無ければ空でよい */
  modules: readonly string[];
  /** 前処理を省いたユニットに送る「前処理なし」の名前 */
  noPreprocessor: string;
  withHiresFix: boolean;
  /** モデルが見つからないときに文面へ足す助言 */
  missingModelAdvice: string;
  product: string;
}

/**
 * alwayson_scripts の ControlNet の args。ユニットは dict の形で渡し、使わない枠は無効で埋める。
 */
export function controlNetArgs(options: ControlNetArgsOptions): Record<string, unknown>[] {
  const { units, limit, product } = options;
  // 超えた分を送らない: 本体が上限より多いユニットを黙って捨て、頼んだ制御の一部が効かないまま描くため
  // （modules/api/api.py の init_script_args。Forge も A1111 も同じ）
  if (units.length > limit) {
    throw new BackendError(
      'failed',
      `ControlNet のユニットが ${units.length} 個あり、${product} に載せられる ${limit} 個を超えている`,
    );
  }
  const args = units.map((unit) => ({
    enabled: true,
    image: options.images.base64(unit.image),
    module:
      unit.module === undefined
        ? options.noPreprocessor
        : resolveModule(unit.module, options.modules, product),
    model: resolveModel(unit.model, options),
    weight: unit.weight,
    guidance_start: unit.guidanceStart,
    guidance_end: unit.guidanceEnd,
    control_mode: CONTROL_MODE[unit.controlMode],
    resize_mode: RESIZE_MODE[unit.resize],
    pixel_perfect: unit.pixelPerfect,
    ...(options.withHiresFix && { hr_option: 'Both' }),
    // 検出マップを応答に付けさせない: 生成した画像の後ろに混ざり、画像の数え方が崩れるため
    save_detected_map: false,
  }));
  // 使わない枠は無効と明示する: 省いた枠は画面の既定で埋まり、その既定を API からは確かめられないため
  const disabled = Array.from({ length: limit - units.length }, () => ({ enabled: false }));
  return [...args, ...disabled];
}

// "名前 [ハッシュ]" の完全一致か、ハッシュを除いた名前の完全一致（1つに決まるとき）だけで引き当てる。
// Forge は完全一致でしか引き当てず、外れると生成の途中で落ちる。A1111 の拡張は外れるとファイル名の部分一致で
// 一番短いものを黙って選ぶ（sd-webui-controlnet の scripts/controlnet.py:76-89）。どちらも先に引き当てて、理由の分かる失敗にする
function resolveModel(
  name: string,
  { models, product, missingModelAdvice }: ControlNetArgsOptions,
): string {
  if (models.includes(name)) return name;
  const byName = models.filter((m) => withoutHash(m) === name);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  throw new BackendError(
    'failed',
    byName.length > 1
      ? `ControlNet のモデル ${name} が ${product} に複数ある。"名前 [ハッシュ]" の形で指定する`
      : `ControlNet のモデル ${name} が ${product} に無い。${missingModelAdvice}`,
  );
}

function resolveModule(name: string, modules: readonly string[], product: string): string {
  if (modules.includes(name)) return name;
  throw new BackendError('failed', `ControlNet の前処理 ${name} が ${product} に無い`);
}
