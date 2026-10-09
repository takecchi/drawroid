import { listSharedCandidates } from '@drawroid/backend-sdapi';
import type { Candidate, CandidateKind } from '@drawroid/core';
import { z } from 'zod';

import type { A1111Client } from './client.js';

// A1111 の VAE は /sdapi/v1/sd-vae で返る。model_name はファイル名（拡張子つき・サブフォルダは付かない）で、
// override_settings.sd_vae にはこの名前を渡す（modules/api/api.py の get_sd_vaes、modules/sd_vae.py の refresh_vae_list）
const sdVaeSchema = z.array(z.object({ model_name: z.string() }));

export async function listA1111Candidates(
  client: A1111Client,
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
      const vaes = await client.getJson('/sdapi/v1/sd-vae', sdVaeSchema, { signal });
      return vaes.map((v) => ({ name: v.model_name }));
    }
    // ControlNet はまだ扱わない（probe で理由付きで「使えない」と報告している）。A1111 の ControlNet は外部の拡張で、
    // 引数の形が Forge の内蔵のものと違うため、確かめずに Forge の形を当てない
    case 'controlnetModel':
    case 'controlnetModule':
      return [];
  }
}
