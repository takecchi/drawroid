import type { Candidate, CandidateKind } from '@drawroid/core';
import { z } from 'zod';

import type { ForgeClient } from './client.js';

// 応答の形は Forge の modules/api/models.py と extensions-builtin/sd_forge_lora に合わせた。使う欄だけを見て、ほかの欄は読まない
const sdModelsSchema = z.array(z.object({ title: z.string(), model_name: z.string() }));
const sdModulesSchema = z.array(z.object({ model_name: z.string() }));
const lorasSchema = z.array(z.object({ name: z.string(), alias: z.string().nullish() }));
const samplersSchema = z.array(z.object({ name: z.string() }));
const schedulersSchema = z.array(z.object({ name: z.string(), label: z.string().nullish() }));

export async function listForgeCandidates(
  client: ForgeClient,
  kind: CandidateKind,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  switch (kind) {
    case 'checkpoint': {
      const models = await client.getJson('/sdapi/v1/sd-models', sdModelsSchema, { signal });
      // name に title を使う: model_name は同じ名前のファイルが別の階層にあると区別できず、title はハッシュまで含めて1つに決まるため
      return models.map((m) => withLabel(m.title, m.model_name));
    }
    case 'vae': {
      // Forge には A1111 の /sdapi/v1/sd-vae が無く、VAE とテキストエンコーダを /sdapi/v1/sd-modules で一緒に返す
      const modules = await client.getJson('/sdapi/v1/sd-modules', sdModulesSchema, { signal });
      return modules.map((m) => ({ name: m.model_name }));
    }
    case 'lora': {
      const loras = await client.getJson('/sdapi/v1/loras', lorasSchema, { signal });
      // name に alias を使う: プロンプトの <lora:…> で Forge が引き当てるのは alias であるため
      return loras.map((l) => withLabel(l.alias || l.name, l.name));
    }
    case 'sampler': {
      const samplers = await client.getJson('/sdapi/v1/samplers', samplersSchema, { signal });
      return samplers.map((s) => ({ name: s.name }));
    }
    case 'scheduler': {
      const schedulers = await client.getJson('/sdapi/v1/schedulers', schedulersSchema, { signal });
      return schedulers.map((s) => withLabel(s.name, s.label ?? undefined));
    }
  }
}

function withLabel(name: string, label: string | undefined): Candidate {
  return label === undefined || label === '' || label === name ? { name } : { name, label };
}
