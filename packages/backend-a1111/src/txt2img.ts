import {
  assertKnownSamplersAndSchedulers,
  resolveCheckpoint,
  withLoras,
} from '@drawroid/backend-sdapi';
import { BackendError, type GenerationRequest } from '@drawroid/core';
import { z } from 'zod';

import type { A1111Client } from './client.js';

const sdVaeSchema = z.array(z.object({ model_name: z.string() }));

/** txt2img と img2img に共通の欄と、txt2img だけの Hires. fix の欄 */
export async function buildA1111Payload(
  client: A1111Client,
  req: GenerationRequest,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const overrideSettings: Record<string, unknown> = {};
  if (req.checkpoint !== undefined) {
    overrideSettings.sd_model_checkpoint = await resolveCheckpoint(client, req.checkpoint, signal);
  }
  if (req.vae !== undefined) {
    overrideSettings.sd_vae = await resolveVae(client, req.vae, signal);
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
    // /sdapi/v1/options で全体の設定を書き換えない: 人間が同じ A1111 を画面から使っていても、その状態を汚さないため
    override_settings: overrideSettings,
    override_settings_restore_afterwards: true,
    // A1111 側の出力フォルダに保存させない: データの置き場所は drawroid のデータディレクトリだけにするため
    save_images: false,
    send_images: true,
  };
}

async function hiresFixFields(
  client: A1111Client,
  req: GenerationRequest,
  hires: NonNullable<GenerationRequest['hiresFix']>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  // 断る: A1111 には二段目の CFG を分ける欄（Forge の hr_cfg）が無く、送っても黙って一段目の CFG で描くため
  // （modules/processing.py の StableDiffusionProcessingTxt2Img）
  if (hires.cfgScale !== undefined && hires.cfgScale !== req.cfgScale) {
    throw new BackendError(
      'failed',
      'A1111 は Hires. fix の二段目の CFG を一段目と分けられない（二段目も一段目の CFG で描く）',
    );
  }
  // Forge の hr_additional_modules・hr_cfg は送らない: A1111 の本文の型に無い欄は、黙って読み捨てられるため
  return {
    enable_hr: true,
    hr_upscaler: hires.upscaler,
    hr_scale: hires.scale,
    hr_second_pass_steps: hires.steps,
    denoising_strength: hires.denoisingStrength,
    ...(hires.checkpoint !== undefined && {
      hr_checkpoint_name: await resolveCheckpoint(client, hires.checkpoint, signal),
    }),
    // 「同じ」は欄を省いて表す: 省けば一段目と同じものを使う（modules/processing.py）
    ...(hires.sampler !== undefined && { hr_sampler_name: hires.sampler }),
    ...(hires.scheduler !== undefined && { hr_scheduler: hires.scheduler }),
    // 二段目のプロンプトにも LoRA を書く: 二段目のプロンプトの LoRA は、一段目とは別に読まれるため
    ...(hires.prompt !== undefined && { hr_prompt: withLoras(hires.prompt, req.loras) }),
    ...(hires.negativePrompt !== undefined && { hr_negative_prompt: hires.negativePrompt }),
  };
}

// A1111 は見つからない VAE の名前を、端末に出すだけで「None」（チェックポイントに入っている VAE）にして描く
// （modules/sd_vae.py の resolve_vae_from_setting）。先に引き当てて、違う VAE で描かれるのを防ぐ
async function resolveVae(client: A1111Client, name: string, signal: AbortSignal): Promise<string> {
  const vaes = await client.getJson('/sdapi/v1/sd-vae', sdVaeSchema, { signal });
  if (!vaes.some((v) => v.model_name === name)) {
    throw new BackendError('failed', `VAE ${name} が A1111 に無い`);
  }
  return name;
}
