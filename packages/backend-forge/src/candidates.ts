import { BackendError, type Candidate, type CandidateKind } from '@drawroid/core';
import { z } from 'zod';

import type { ForgeClient } from './client.js';

// 応答の形は Forge の modules/api/models.py と extensions-builtin/sd_forge_lora に合わせた。使う欄だけを見て、ほかの欄は読まない
const sdModelsSchema = z.array(z.object({ title: z.string(), model_name: z.string() }));
const sdModulesSchema = z.array(z.object({ model_name: z.string() }));
const lorasSchema = z.array(z.object({ name: z.string(), alias: z.string().nullish() }));
const samplersSchema = z.array(z.object({ name: z.string() }));
const schedulersSchema = z.array(z.object({ name: z.string(), label: z.string().nullish() }));
const namedSchema = z.array(z.object({ name: z.string() }));

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
      // name に alias を使わない: Forge は <lora:…> を name でも alias でも引き当てるが、alias が他の LoRA と重なると、その alias では引き当てなくなるため（sd_forge_lora/networks.py）
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
    case 'controlnetModel': {
      const models = await listControlNetModels(client, signal);
      return models.map((name) => withLabel(name, withoutHash(name)));
    }
    case 'controlnetModule': {
      const modules = await listControlNetModules(client, signal);
      return modules.map((name) => ({ name }));
    }
  }
}

const modelListSchema = z.object({ model_list: z.array(z.string()) });
const moduleListSchema = z.object({ module_list: z.array(z.string()) });

// 'None' を出さない: Forge の「指定なし」の名前で、中立の要求では欄を省くことで表すため
const FORGE_NONE = 'None';

/**
 * ControlNet のモデルの名前（"名前 [ハッシュ]"。Forge はこの形の完全一致でしか引き当てない）。
 * ControlNet が読み込まれていない Forge には、この API 自体が無いので空を返す。
 */
// 一覧は Forge の起動時に作られ、?update=true を付けても作り直されない（sd_forge_controlnet/lib_controlnet/api.py）。
// モデルを置いたら Forge の再起動か、画面の更新ボタンが要る
export async function listControlNetModels(
  client: ForgeClient,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await getIfPresent(client, '/controlnet/model_list', modelListSchema, signal);
  return (res?.model_list ?? []).filter((name) => name !== FORGE_NONE);
}

export async function listControlNetModules(
  client: ForgeClient,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await getIfPresent(client, '/controlnet/module_list', moduleListSchema, signal);
  return (res?.module_list ?? []).filter((name) => name !== FORGE_NONE);
}

async function getIfPresent<S extends z.ZodType>(
  client: ForgeClient,
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

function withoutHash(name: string): string {
  return name.replace(/ \[[0-9a-f]+\]$/i, '');
}

function withLabel(name: string, label: string | undefined): Candidate {
  return label === undefined || label === '' || label === name ? { name } : { name, label };
}
