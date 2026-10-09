import { BackendError, type GenerationRequest, type GenerationResult } from '@drawroid/core';
import { z } from 'zod';

import type { ForgeClient } from './client.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const sdModelsSchema = z.array(z.object({ title: z.string(), model_name: z.string() }));
const sdModulesSchema = z.array(z.object({ model_name: z.string(), filename: z.string() }));

// info は JSON の文字列で返る。使う欄だけを見る
const txt2imgInfoSchema = z.looseObject({
  seed: z.number().nullish(),
  all_seeds: z.array(z.number()).nullish(),
  infotexts: z.array(z.string()).nullish(),
  index_of_first_image: z.number().int().nonnegative().nullish(),
});

// txt2img と img2img は同じ形で返す（modules/api/models.py の TextToImageResponse・ImageToImageResponse）
export const generationResponseSchema = z.object({
  images: z.array(z.string()),
  info: z.string(),
});

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

export function withLoras(prompt: string, loras: GenerationRequest['loras']): string {
  if (loras.length === 0) return prompt;
  for (const lora of loras) {
    if (/[:<>]/.test(lora.name)) {
      throw new BackendError(
        'failed',
        `LoRA の名前に : < > を含むものは指定できない: ${lora.name}`,
      );
    }
  }
  // 3つ目の値が UNet の重みになる（sd_forge_lora/extra_networks_lora.py）
  const tags = loras
    .map((l) =>
      l.unetWeight === undefined
        ? `<lora:${l.name}:${l.weight}>`
        : `<lora:${l.name}:${l.weight}:${l.unetWeight}>`,
    )
    .join(' ');
  return prompt === '' ? tags : `${prompt} ${tags}`;
}

export function readTxt2imgResponse(
  res: z.infer<typeof generationResponseSchema>,
  batchSize: number,
  endpoint: 'txt2img' | 'img2img' = 'txt2img',
): GenerationResult {
  let info: z.infer<typeof txt2imgInfoSchema>;
  try {
    info = txt2imgInfoSchema.parse(JSON.parse(res.info));
  } catch (error) {
    throw new BackendError('bad_response', `${endpoint} の info が読めない`, { cause: error });
  }
  // バッチが2枚以上のとき、Forge は格子画像を先頭に足すことがある。index_of_first_image が個々の画像の始まりを指す。
  // 枚数ぶんだけ切り出す: ControlNet の検出マップなど、生成した画像でないものが末尾に付くことがあるため（modules/api/api.py）
  const first = info.index_of_first_image ?? 0;
  const encoded = res.images.slice(first, first + batchSize);
  if (encoded.length !== batchSize) {
    throw new BackendError(
      'bad_response',
      // Forge は interrupt されても失敗を返さず、そこまでに描けた画像だけを返す
      `${endpoint} が ${batchSize} 枚を返すはずが ${encoded.length} 枚だった。Forge の画面などで生成が中断された可能性がある`,
    );
  }
  const images = encoded.map((b64, i) => {
    const png = Uint8Array.from(Buffer.from(b64, 'base64'));
    if (!PNG_SIGNATURE.every((byte, j) => png[j] === byte)) {
      throw new BackendError(
        'bad_response',
        `${endpoint} の画像が PNG ではない。Forge の設定の画像形式（samples_format）を png にする`,
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
