import type { Candidate, CandidateKind } from '@drawroid/core';
import { z } from 'zod';

import type { SdapiClient } from './client.js';

// 応答の形は Forge・A1111 の modules/api/models.py と、LoRA の拡張（Forge の sd_forge_lora、A1111 の extensions-builtin/Lora）に合わせた。
// 使う欄だけを見て、ほかの欄は読まない
const sdModelsSchema = z.array(z.object({ title: z.string(), model_name: z.string() }));
const lorasSchema = z.array(z.object({ name: z.string(), alias: z.string().nullish() }));
const samplersSchema = z.array(z.object({ name: z.string() }));
const schedulersSchema = z.array(z.object({ name: z.string(), label: z.string().nullish() }));
const namedSchema = z.array(z.object({ name: z.string() }));

/** Forge・A1111 で、同じ口・同じ形で取れる候補の種類 */
export type SharedCandidateKind = Extract<
  CandidateKind,
  'checkpoint' | 'lora' | 'sampler' | 'scheduler' | 'upscaler'
>;

export async function listSharedCandidates(
  client: SdapiClient,
  kind: SharedCandidateKind,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  switch (kind) {
    case 'checkpoint': {
      const models = await client.getJson('/sdapi/v1/sd-models', sdModelsSchema, { signal });
      // name に title を使う: model_name は同じ名前のファイルが別の階層にあると区別できず、title はハッシュまで含めて1つに決まるため
      return models.map((m) => withLabel(m.title, m.model_name));
    }
    case 'lora': {
      const loras = await client.getJson('/sdapi/v1/loras', lorasSchema, { signal });
      // name に alias を使わない: <lora:…> は name でも alias でも引き当てるが、alias が他の LoRA と重なると、その alias では引き当てなくなるため
      // （Forge の sd_forge_lora/networks.py、A1111 の extensions-builtin/Lora/networks.py）
      return loras.map((l) => withLabel(l.name, l.alias ?? undefined));
    }
    case 'sampler': {
      const samplers = await client.getJson('/sdapi/v1/samplers', samplersSchema, { signal });
      return samplers.map((s) => ({ name: s.name }));
    }
    case 'scheduler': {
      const schedulers = await client.getJson('/sdapi/v1/schedulers', schedulersSchema, { signal });
      return schedulers.map((s) => withLabel(s.name, s.label ?? undefined));
    }
    case 'upscaler': {
      // Hires. fix の hr_upscaler が受け付けるのは、潜在空間の方式（latent-upscale-modes）と画像の拡大器（upscalers）を合わせたもの（modules/processing.py）
      const latent = await client.getJson('/sdapi/v1/latent-upscale-modes', namedSchema, {
        signal,
      });
      const upscalers = await client.getJson('/sdapi/v1/upscalers', namedSchema, { signal });
      // None を出さない: 拡大せずに Hires. fix を回すことになり、選ばせる意味が無いため
      return [...latent, ...upscalers]
        .filter((u) => u.name !== 'None')
        .map((u) => ({ name: u.name }));
    }
  }
}

export function withLabel(name: string, label: string | undefined): Candidate {
  return label === undefined || label === '' || label === name ? { name } : { name, label };
}
