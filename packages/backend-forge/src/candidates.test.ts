import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listForgeCandidates } from './candidates.js';
import { ForgeClient } from './client.js';
import { json, startMockForge, type MockForge } from './test-support/mock-forge.js';

let forge: MockForge;
let client: ForgeClient;

beforeEach(async () => {
  forge = await startMockForge();
  client = new ForgeClient({ baseUrl: forge.url, timeoutMs: 5_000 });
});

afterEach(async () => {
  await forge.close();
});

describe('listForgeCandidates', () => {
  it('names checkpoints by title so that each one is unambiguous', async () => {
    expect(await listForgeCandidates(client, 'checkpoint')).toEqual([
      { name: 'animagine-xl-4.0.safetensors [6327eca98b]', label: 'animagine-xl-4.0' },
      { name: 'real/juggernaut-xl.safetensors', label: 'real/juggernaut-xl' },
    ]);
  });

  it('reads VAEs from sd-modules, which Forge uses instead of sd-vae', async () => {
    expect(await listForgeCandidates(client, 'vae')).toEqual([
      { name: 'sdxl_vae.safetensors' },
      { name: 'clip_l.safetensors' },
    ]);
  });

  it('names LoRAs by the name that resolves even when aliases collide, showing the alias', async () => {
    expect(await listForgeCandidates(client, 'lora')).toEqual([
      { name: 'detail-tweaker-xl' },
      { name: 'watercolor_style_v2', label: 'watercolor' },
    ]);
  });

  it('lists samplers and schedulers', async () => {
    expect(await listForgeCandidates(client, 'sampler')).toEqual([
      { name: 'Euler a' },
      { name: 'DPM++ 2M' },
    ]);
    expect(await listForgeCandidates(client, 'scheduler')).toEqual([
      { name: 'automatic', label: 'Automatic' },
      { name: 'karras', label: 'Karras' },
    ]);
  });

  it('returns an empty list when Forge has none of a kind', async () => {
    forge.route('GET /sdapi/v1/loras', json(200, []));
    expect(await listForgeCandidates(client, 'lora')).toEqual([]);
  });

  it('reports a list with an unexpected shape as a bad response', async () => {
    forge.route('GET /sdapi/v1/sd-models', json(200, [{ unexpected: true }]));
    await expect(listForgeCandidates(client, 'checkpoint')).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});

describe('listForgeCandidates for Hires. fix and ControlNet', () => {
  it('offers both latent and image upscalers for Hires. fix, leaving out None', async () => {
    expect(await listForgeCandidates(client, 'upscaler')).toEqual([
      { name: 'Latent' },
      { name: 'Latent (bicubic antialiased)' },
      { name: 'Lanczos' },
      { name: 'R-ESRGAN 4x+' },
    ]);
  });

  it('names ControlNet models with their hash, which Forge needs to find them, showing the bare name', async () => {
    expect(await listForgeCandidates(client, 'controlnetModel')).toEqual([
      { name: 'diffusers_xl_canny_full [2b69fca4]', label: 'diffusers_xl_canny_full' },
      { name: 'control_v11f1p_sd15_depth [cfd03158]', label: 'control_v11f1p_sd15_depth' },
    ]);
  });

  it("lists ControlNet preprocessors, leaving out Forge's own None", async () => {
    expect(await listForgeCandidates(client, 'controlnetModule')).toEqual([
      { name: 'canny' },
      { name: 'depth_anything' },
      { name: 'lineart_anime' },
    ]);
  });

  it('offers no ControlNet candidates when Forge has not loaded ControlNet', async () => {
    forge.route('GET /controlnet/model_list', json(404, { detail: 'Not Found' }));
    forge.route('GET /controlnet/module_list', json(404, { detail: 'Not Found' }));

    expect(await listForgeCandidates(client, 'controlnetModel')).toEqual([]);
    expect(await listForgeCandidates(client, 'controlnetModule')).toEqual([]);
  });
});
