import {
  controlNetArgs,
  fetchControlNetModels,
  fetchControlNetModules,
  type ResolvedImages,
} from '@drawroid/backend-sdapi';
import { BackendError, type ControlNetUnit } from '@drawroid/core';
import { z } from 'zod';

import type { A1111Client } from './client.js';

// 確かめた版は sd-webui-controlnet の v1.1.455（56cec5b）のソース。実機では未確認

/** ControlNet の拡張（Mikubill/sd-webui-controlnet）がスクリプトとして載る名前。拡張の title は "ControlNet" */
export const A1111_CONTROLNET_SCRIPT = 'controlnet';

// 拡張の「前処理なし」の名前。Forge の 'None' と違い小文字（scripts/preprocessor/model_free_preprocessors.py:13）
const NO_PREPROCESSOR = 'none';

// 拡張の weight の上限（internal_controlnet/args.py:94 の le=2.0）。超えると拡張の検証で生成が落ちる
const MAX_WEIGHT = 2;

const scriptsSchema = z.object({ txt2img: z.array(z.string()), img2img: z.array(z.string()) });
const settingsSchema = z.object({ control_net_unit_count: z.number().int().positive() });

// スクリプトは名前（title の小文字）で載る（modules/scripts.py）
export async function hasControlNet(client: A1111Client, signal?: AbortSignal): Promise<boolean> {
  const scripts = await client.getJson('/sdapi/v1/scripts', scriptsSchema, { signal });
  return (
    scripts.txt2img.includes(A1111_CONTROLNET_SCRIPT) &&
    scripts.img2img.includes(A1111_CONTROLNET_SCRIPT)
  );
}

/**
 * 1回の生成に載せられるユニットの数。拡張が設定 control_net_unit_count をそのまま返す（scripts/api.py:94-97）。
 * 口が無ければ undefined。
 */
export async function countControlNetUnits(
  client: A1111Client,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const settings = await client.getJson('/controlnet/settings', settingsSchema, { signal });
    return settings.control_net_unit_count;
  } catch (error) {
    if (error instanceof BackendError && error.kind === 'not_found') return undefined;
    throw error;
  }
}

/** モデルの名前（"名前 [ハッシュ]"）。拡張が無ければ空 */
// 拡張は呼ぶたびにモデルのフォルダを読み直す（scripts/api.py:54-58 の update の既定が true）。
// 一覧に "None" は含まれない（scripts/global_state.py:83-89）
export async function listControlNetModels(
  client: A1111Client,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await fetchControlNetModels(client, signal)) ?? [];
}

/** 前処理の名前。拡張の「前処理なし」は出さない: 中立の要求では欄を省くことで表すため */
export async function listControlNetModules(
  client: A1111Client,
  signal?: AbortSignal,
): Promise<string[]> {
  return ((await fetchControlNetModules(client, signal)) ?? []).filter(
    (name) => name !== NO_PREPROCESSOR,
  );
}

/**
 * alwayson_scripts に載せる ControlNet の引数。ユニットの形は Forge と同じ dict。
 */
export async function controlNetScript(
  client: A1111Client,
  units: readonly ControlNetUnit[],
  images: ResolvedImages,
  options: { withHiresFix: boolean; signal: AbortSignal },
): Promise<Record<string, unknown>> {
  const { signal } = options;
  if (!(await hasControlNet(client, signal))) {
    throw new BackendError(
      'failed',
      'A1111 に ControlNet の拡張（sd-webui-controlnet）が入っていない',
    );
  }
  const limit = await countControlNetUnits(client, signal);
  if (limit === undefined) {
    throw new BackendError('failed', CONTROLNET_SETTINGS_MISSING);
  }
  const heavy = units.find((u) => u.weight > MAX_WEIGHT);
  if (heavy !== undefined) {
    throw new BackendError(
      'failed',
      `ControlNet の weight ${heavy.weight} は、A1111 の ControlNet の拡張の上限 ${MAX_WEIGHT} を超えている`,
    );
  }
  const args = controlNetArgs({
    units,
    images,
    limit,
    models: await listControlNetModels(client, signal),
    modules: units.some((u) => u.module !== undefined)
      ? await listControlNetModules(client, signal)
      : [],
    noPreprocessor: NO_PREPROCESSOR,
    withHiresFix: options.withHiresFix,
    missingModelAdvice: 'A1111 の ControlNet のモデルのフォルダに置いたかを確かめる',
    product: client.product,
  });
  return { [A1111_CONTROLNET_SCRIPT]: { args } };
}

export const CONTROLNET_SETTINGS_MISSING =
  'A1111 の ControlNet の拡張に /controlnet/settings が無く、載せられるユニットの数が分からない。拡張を新しくする';
