import { BackendError, type GenerationRequest } from '@drawroid/core';
import { z } from 'zod';

import type { SdapiClient } from './client.js';

const samplersSchema = z.array(z.object({ name: z.string() }));
const schedulersSchema = z.array(
  z.object({ name: z.string(), label: z.string(), aliases: z.array(z.string()).nullish() }),
);

/**
 * サンプラとスケジューラの名前を、バックエンドの一覧に照らす。無ければ、生成を頼む前に失敗させる。
 */
// Forge・A1111 は知らない名前を失敗にせず、黙って既定のものに置き換えて描くことがある（modules/sd_samplers.py の
// get_sampler_and_scheduler と fix_p_invalid_sampler_and_scheduler、modules/api/api.py の txt2img・img2img）。
// そのまま渡すと、request.json の名前と実際に描いた名前が食い違うため（Issue #41）。
// 照らし方は Forge・A1111 が引き当てる形に揃える: サンプラは名前だけ（別名では引かない）、または「サンプラ名 スケジューラ名」の形。
// スケジューラは name か label
export async function assertKnownSamplersAndSchedulers(
  client: SdapiClient,
  req: GenerationRequest,
  signal: AbortSignal,
): Promise<void> {
  const samplers = [req.sampler, req.hiresFix?.sampler].filter((n) => n !== undefined);
  const schedulers = [req.scheduler, req.hiresFix?.scheduler].filter((n) => n !== undefined);
  if (samplers.length === 0 && schedulers.length === 0) return;

  const knownSamplers = new Set(
    (await client.getJson('/sdapi/v1/samplers', samplersSchema, { signal })).map((s) => s.name),
  );
  const schedulerList = await client.getJson('/sdapi/v1/schedulers', schedulersSchema, { signal });
  const knownSchedulers = new Set(schedulerList.flatMap((s) => [s.name, s.label]));
  const schedulerSuffixes = schedulerList.flatMap((s) => [s.label, s.name, ...(s.aliases ?? [])]);

  for (const name of samplers) {
    const known =
      knownSamplers.has(name) ||
      schedulerSuffixes.some(
        (suffix) =>
          name.endsWith(` ${suffix}`) && knownSamplers.has(name.slice(0, -suffix.length - 1)),
      );
    if (!known) throw new BackendError('failed', `サンプラ ${name} が ${client.product} に無い`);
  }
  for (const name of schedulers) {
    if (!knownSchedulers.has(name)) {
      throw new BackendError('failed', `スケジューラ ${name} が ${client.product} に無い`);
    }
  }
}
