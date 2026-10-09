import type { ResolvedImages } from '@drawroid/backend-sdapi';
import { BackendError, type ControlNetUnit, type ResizeMode } from '@drawroid/core';

import { listControlNetModels, listControlNetModules } from './candidates.js';
import type { ForgeClient } from './client.js';
import { countControlNetUnits, FORGE_CONTROLNET_SCRIPT, hasControlNet } from './probe.js';

// 文字列で渡す: Forge の ControlNet は control_mode を文字列で比べており、数を渡すと黙って Balanced になるため
// （sd_forge_controlnet/scripts/controlnet.py）
const CONTROL_MODE: Record<ControlNetUnit['controlMode'], string> = {
  balanced: 'Balanced',
  prompt: 'My prompt is more important',
  controlnet: 'ControlNet is more important',
};

const RESIZE_MODE: Record<ResizeMode, string> = {
  stretch: 'Just Resize',
  crop: 'Crop and Resize',
  fill: 'Resize and Fill',
};

// Forge の「前処理なし」の名前。小文字の 'none' は Forge に無い（modules_forge/supported_preprocessor.py）
const NO_PREPROCESSOR = 'None';

/**
 * alwayson_scripts に載せる ControlNet の引数。ユニットは Forge の dict の形で渡す。
 */
export async function controlNetScript(
  client: ForgeClient,
  units: readonly ControlNetUnit[],
  images: ResolvedImages,
  options: { withHiresFix: boolean; signal: AbortSignal },
): Promise<Record<string, unknown>> {
  const { signal } = options;
  if (!(await hasControlNet(client, signal))) {
    throw new BackendError(
      'failed',
      'Forge に ControlNet（内蔵の sd_forge_controlnet）が読み込まれていない',
    );
  }
  // 超えた分を送らない: Forge は上限より多いユニットを黙って捨て、頼んだ制御の一部が効かないまま描くため
  const limit = await countControlNetUnits(client, signal);
  if (units.length > limit) {
    throw new BackendError(
      'failed',
      `ControlNet のユニットが ${units.length} 個あり、Forge に載せられる ${limit} 個を超えている`,
    );
  }
  const models = await listControlNetModels(client, signal);
  const modules = units.some((u) => u.module !== undefined)
    ? await listControlNetModules(client, signal)
    : [];

  const args = units.map((unit) => ({
    enabled: true,
    image: images.base64(unit.image),
    module: unit.module === undefined ? NO_PREPROCESSOR : resolveModule(unit.module, modules),
    model: resolveModel(unit.model, models),
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
  // 使わない枠は無効と明示する: 省いた枠は Forge の画面の既定で埋まり、その既定を API からは確かめられないため
  const disabled = Array.from({ length: limit - units.length }, () => ({ enabled: false }));
  return { [FORGE_CONTROLNET_SCRIPT]: { args: [...args, ...disabled] } };
}

// Forge は "名前 [ハッシュ]" の完全一致でしか引き当てず、外れると生成の途中で落ちる。先に引き当てて、理由の分かる失敗にする
function resolveModel(name: string, models: readonly string[]): string {
  if (models.includes(name)) return name;
  const byName = models.filter((m) => m.replace(/ \[[0-9a-f]+\]$/i, '') === name);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  throw new BackendError(
    'failed',
    byName.length > 1
      ? `ControlNet のモデル ${name} が Forge に複数ある。"名前 [ハッシュ]" の形で指定する`
      : `ControlNet のモデル ${name} が Forge に無い。モデルを置いたあとは Forge の再起動か画面の更新が要る`,
  );
}

function resolveModule(name: string, modules: readonly string[]): string {
  if (modules.includes(name)) return name;
  throw new BackendError('failed', `ControlNet の前処理 ${name} が Forge に無い`);
}
