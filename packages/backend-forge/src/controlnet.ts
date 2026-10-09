import { controlNetArgs, type ResolvedImages } from '@drawroid/backend-sdapi';
import { BackendError, type ControlNetUnit } from '@drawroid/core';

import { listControlNetModels, listControlNetModules } from './candidates.js';
import type { ForgeClient } from './client.js';
import { countControlNetUnits, FORGE_CONTROLNET_SCRIPT, hasControlNet } from './probe.js';

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
  const limit = await countControlNetUnits(client, signal);
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
    missingModelAdvice: 'モデルを置いたあとは Forge の再起動か画面の更新が要る',
    product: client.product,
  });
  return { [FORGE_CONTROLNET_SCRIPT]: { args } };
}
