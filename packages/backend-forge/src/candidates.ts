import { listSharedCandidates, withLabel } from '@drawroid/backend-sdapi';
import { BackendError, type Candidate, type CandidateKind } from '@drawroid/core';
import { z } from 'zod';

import type { ForgeClient } from './client.js';

const sdModulesSchema = z.array(z.object({ model_name: z.string() }));

export async function listForgeCandidates(
  client: ForgeClient,
  kind: CandidateKind,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  switch (kind) {
    case 'checkpoint':
    case 'lora':
    case 'sampler':
    case 'scheduler':
    case 'upscaler':
      return listSharedCandidates(client, kind, signal);
    case 'vae': {
      // Forge には A1111 の /sdapi/v1/sd-vae が無く、VAE とテキストエンコーダを /sdapi/v1/sd-modules で一緒に返す
      const modules = await client.getJson('/sdapi/v1/sd-modules', sdModulesSchema, { signal });
      return modules.map((m) => ({ name: m.model_name }));
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
