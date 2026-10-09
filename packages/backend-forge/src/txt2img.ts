import {
  assertKnownSamplersAndSchedulers,
  resolveCheckpoint,
  withLoras,
} from '@drawroid/backend-sdapi';
import { BackendError, type GenerationRequest } from '@drawroid/core';
import { z } from 'zod';

import type { ForgeClient } from './client.js';

const sdModulesSchema = z.array(z.object({ model_name: z.string(), filename: z.string() }));

/** txt2img と img2img に共通の欄と、txt2img だけの Hires. fix の欄 */
export async function buildTxt2imgPayload(
  client: ForgeClient,
  req: GenerationRequest,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const overrideSettings: Record<string, unknown> = {};
  if (req.checkpoint !== undefined) {
    overrideSettings.sd_model_checkpoint = await resolveCheckpoint(client, req.checkpoint, signal);
  }
  if (req.vae !== undefined) {
    overrideSettings.forge_additional_modules = [await resolveModulePath(client, req.vae, signal)];
  }
  await assertKnownSamplersAndSchedulers(client, req, signal);
  return {
    prompt: withLoras(req.prompt, req.loras),
    negative_prompt: req.negativePrompt,
    ...(req.sampler !== undefined && { sampler_name: req.sampler }),
    ...(req.scheduler !== undefined && { scheduler: req.scheduler }),
    steps: req.steps,
    cfg_scale: req.cfgScale,
    seed: req.seed ?? -1,
    width: req.width,
    height: req.height,
    batch_size: req.batchSize,
    n_iter: 1,
    ...(req.hiresFix !== undefined && (await hiresFixFields(client, req, req.hiresFix, signal))),
    // /sdapi/v1/options で全体の設定を書き換えない: 人間が同じ Forge を画面から使っていても、その状態を汚さないため
    override_settings: overrideSettings,
    override_settings_restore_afterwards: true,
    // Forge 側の出力フォルダに保存させない: データの置き場所は drawroid のデータディレクトリだけにするため
    save_images: false,
    send_images: true,
  };
}

async function hiresFixFields(
  client: ForgeClient,
  req: GenerationRequest,
  hires: NonNullable<GenerationRequest['hiresFix']>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return {
    enable_hr: true,
    hr_upscaler: hires.upscaler,
    hr_scale: hires.scale,
    hr_second_pass_steps: hires.steps,
    denoising_strength: hires.denoisingStrength,
    // 省かない: Forge は省いた hr_additional_modules を None のまま「含むか」を調べて落ちる。[] は「内蔵のものだけ」の意味になり、指定した VAE が二段目で外れる
    hr_additional_modules: ['Use same choices'],
    // 省かない: Forge の hr_cfg の既定は 1.0 で、1.0 のとき二段目はネガティブプロンプトを黙って無視する（modules/processing.py）
    hr_cfg: hires.cfgScale ?? req.cfgScale,
    ...(hires.checkpoint !== undefined && {
      hr_checkpoint_name: await resolveCheckpoint(client, hires.checkpoint, signal),
    }),
    // 「同じ」は欄を省いて表す: API には画面の 'Use same sampler' を None に直す処理が無く、その文字列を送ると落ちる（modules/txt2img.py）
    ...(hires.sampler !== undefined && { hr_sampler_name: hires.sampler }),
    ...(hires.scheduler !== undefined && { hr_scheduler: hires.scheduler }),
    // 二段目のプロンプトにも LoRA を書く: 二段目のプロンプトの LoRA は、一段目とは別に読まれるため
    ...(hires.prompt !== undefined && { hr_prompt: withLoras(hires.prompt, req.loras) }),
    ...(hires.negativePrompt !== undefined && { hr_negative_prompt: hires.negativePrompt }),
  };
}

// Forge の forge_additional_modules はファイルのパスで指定する
async function resolveModulePath(
  client: ForgeClient,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  const modules = await client.getJson('/sdapi/v1/sd-modules', sdModulesSchema, { signal });
  const found = modules.find((m) => m.model_name === name);
  if (found === undefined) throw new BackendError('failed', `VAE ${name} が Forge に無い`);
  return found.filename;
}
