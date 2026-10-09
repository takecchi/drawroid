import { BackendError, type GenerationRequest, type GenerationResult } from '@drawroid/core';
import { z } from 'zod';

import type { ForgeClient } from './client.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const sdModelsSchema = z.array(z.object({ title: z.string(), model_name: z.string() }));
const sdModulesSchema = z.array(z.object({ model_name: z.string(), filename: z.string() }));

const txt2imgResponseSchema = z.object({
  images: z.array(z.string()),
  info: z.string(),
});

// info は JSON の文字列で返る。使う欄だけを見る
const txt2imgInfoSchema = z.looseObject({
  seed: z.number().nullish(),
  all_seeds: z.array(z.number()).nullish(),
  infotexts: z.array(z.string()).nullish(),
  index_of_first_image: z.number().int().nonnegative().nullish(),
});

export async function generateWithForge(
  client: ForgeClient,
  req: GenerationRequest,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<GenerationResult> {
  const payload = await buildTxt2imgPayload(client, req, options.signal);
  const res = await client.postJson('/sdapi/v1/txt2img', payload, txt2imgResponseSchema, options);
  return readTxt2imgResponse(res, req.batchSize);
}

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
    ...(req.hiresFix !== undefined && {
      enable_hr: true,
      hr_upscaler: req.hiresFix.upscaler,
      hr_scale: req.hiresFix.scale,
      hr_second_pass_steps: req.hiresFix.steps,
      denoising_strength: req.hiresFix.denoisingStrength,
    }),
    // /sdapi/v1/options で全体の設定を書き換えない: 人間が同じ Forge を画面から使っていても、その状態を汚さないため
    override_settings: overrideSettings,
    override_settings_restore_afterwards: true,
    // Forge 側の出力フォルダに保存させない: データの置き場所は drawroid のデータディレクトリだけにするため
    save_images: false,
    send_images: true,
  };
}

// Forge は見つからないチェックポイントの指定を黙って捨て、いま読み込まれているモデルで生成する。先に引き当てて、違うモデルで描かれるのを防ぐ
async function resolveCheckpoint(
  client: ForgeClient,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  const models = await client.getJson('/sdapi/v1/sd-models', sdModelsSchema, { signal });
  const found = models.find((m) => m.title === name || m.model_name === name);
  if (found === undefined) {
    throw new BackendError('failed', `チェックポイント ${name} が Forge に無い`);
  }
  return found.title;
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

function withLoras(prompt: string, loras: GenerationRequest['loras']): string {
  if (loras.length === 0) return prompt;
  for (const lora of loras) {
    if (/[:<>]/.test(lora.name)) {
      throw new BackendError(
        'failed',
        `LoRA の名前に : < > を含むものは指定できない: ${lora.name}`,
      );
    }
  }
  const tags = loras.map((l) => `<lora:${l.name}:${l.weight}>`).join(' ');
  return prompt === '' ? tags : `${prompt} ${tags}`;
}

export function readTxt2imgResponse(
  res: z.infer<typeof txt2imgResponseSchema>,
  batchSize: number,
): GenerationResult {
  let info: z.infer<typeof txt2imgInfoSchema>;
  try {
    info = txt2imgInfoSchema.parse(JSON.parse(res.info));
  } catch (error) {
    throw new BackendError('bad_response', 'txt2img の info が読めない', { cause: error });
  }
  // バッチが2枚以上のとき、Forge は格子画像を先頭に足すことがある。index_of_first_image が個々の画像の始まりを指す
  const first = info.index_of_first_image ?? 0;
  const encoded = res.images.slice(first, first + batchSize);
  if (encoded.length !== batchSize) {
    throw new BackendError(
      'bad_response',
      `txt2img が ${batchSize} 枚を返すはずが ${encoded.length} 枚だった`,
    );
  }
  const images = encoded.map((b64, i) => {
    const png = Uint8Array.from(Buffer.from(b64, 'base64'));
    if (!PNG_SIGNATURE.every((byte, j) => png[j] === byte)) {
      throw new BackendError(
        'bad_response',
        'txt2img の画像が PNG ではない。Forge の設定の画像形式（samples_format）を png にする',
      );
    }
    return {
      png,
      seed: info.all_seeds?.[i] ?? (i === 0 ? (info.seed ?? null) : null),
      metadata: { infotext: info.infotexts?.[first + i] ?? null },
    };
  });
  return { images, metadata: { info } };
}
