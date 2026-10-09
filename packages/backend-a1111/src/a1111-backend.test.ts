import { BackendError, generationRequestSchema, type GenerationImages } from '@drawroid/core';
import { describeImageBackendContract, STUB_PNG } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { A1111Backend } from './a1111-backend.js';
import { startMockA1111, unusedUrl, type MockA1111 } from './test-support/mock-a1111.js';

describeImageBackendContract('A1111Backend against the mock A1111 (v1.10.1 fixtures)', {
  connected: async () => {
    const a1111 = await startMockA1111();
    return { backend: new A1111Backend({ baseUrl: a1111.url }), close: () => a1111.close() };
  },
  unreachable: async () => ({ backend: new A1111Backend({ baseUrl: await unusedUrl() }) }),
});

// ControlNet の拡張の雛形は sd-webui-controlnet v1.1.455（56cec5b）のソースから起こしたもので、実機の応答ではない
describeImageBackendContract(
  'A1111Backend against the mock A1111 with the ControlNet extension (v1.1.455 fixtures)',
  {
    connected: async () => {
      const a1111 = await startMockA1111({ controlnet: true });
      return { backend: new A1111Backend({ baseUrl: a1111.url }), close: () => a1111.close() };
    },
    unreachable: async () => ({ backend: new A1111Backend({ baseUrl: await unusedUrl() }) }),
  },
);

const base = { prompt: 'a cat', steps: 4, cfgScale: 7, seed: 42, width: 64, height: 64 };

describe('A1111Backend', () => {
  let a1111: MockA1111;
  let backend: A1111Backend;

  beforeEach(async () => {
    a1111 = await startMockA1111();
    backend = new A1111Backend({ baseUrl: a1111.url });
  });

  afterEach(async () => {
    await a1111.close();
  });

  function sent(path: string): Record<string, unknown> {
    const request = a1111.requests.find((r) => r.method === 'POST' && r.path === path);
    if (request === undefined) throw new Error(`${path} は呼ばれていない`);
    return JSON.parse(request.body) as Record<string, unknown>;
  }

  function generate(req: Record<string, unknown>, images?: GenerationImages) {
    return backend.generate(
      generationRequestSchema.parse({ ...base, ...req }),
      new AbortController().signal,
      images,
    );
  }

  it('lists VAEs from /sdapi/v1/sd-vae, and picks one with sd_vae', async () => {
    expect(await backend.listCandidates('vae')).toEqual([
      { name: 'sdxl_vae.safetensors' },
      { name: 'anime-vae.pt' },
    ]);

    await generate({ vae: 'anime-vae.pt' });

    const body = sent('/sdapi/v1/txt2img');
    expect(body.override_settings).toEqual({ sd_vae: 'anime-vae.pt' });
    expect(a1111.requests.some((r) => r.path === '/sdapi/v1/sd-modules')).toBe(false);
  });

  it('refuses a VAE that A1111 does not have, before asking it to generate', async () => {
    await expect(generate({ vae: 'missing.safetensors' })).rejects.toThrow(
      'VAE missing.safetensors が A1111 に無い',
    );
    expect(a1111.requests.some((r) => r.path === '/sdapi/v1/txt2img')).toBe(false);
  });

  it('picks a checkpoint in a subfolder by its title or its model name', async () => {
    await generate({ checkpoint: 'real_juggernaut-xl' });
    expect(sent('/sdapi/v1/txt2img').override_settings).toEqual({
      sd_model_checkpoint: 'real/juggernaut-xl.safetensors',
    });
    await expect(generate({ checkpoint: 'real/juggernaut-xl' })).rejects.toThrow(
      'チェックポイント real/juggernaut-xl が A1111 に無い',
    );
  });

  it('sends Hires. fix without the fields only Forge has', async () => {
    await generate({
      hiresFix: { upscaler: 'Latent', scale: 1.5, steps: 10, denoisingStrength: 0.5 },
    });

    const body = sent('/sdapi/v1/txt2img');
    expect(body).toMatchObject({ enable_hr: true, hr_upscaler: 'Latent', hr_scale: 1.5 });
    expect(body).not.toHaveProperty('hr_additional_modules');
    expect(body).not.toHaveProperty('hr_cfg');
  });

  it('refuses a second-pass CFG that differs, since A1111 would quietly use the first one', async () => {
    await expect(
      generate({
        hiresFix: {
          upscaler: 'Latent',
          scale: 1.5,
          steps: 10,
          denoisingStrength: 0.5,
          cfgScale: 4,
        },
      }),
    ).rejects.toThrow('二段目の CFG');
    expect(a1111.requests.some((r) => r.path === '/sdapi/v1/txt2img')).toBe(false);
  });

  it('sends img2img to /sdapi/v1/img2img with the source image', async () => {
    const images: GenerationImages = new Map([
      ['iterations/0001/images/0.png', { data: STUB_PNG, mediaType: 'image/png' }],
    ]);

    const result = await generate(
      { img2img: { image: 'iterations/0001/images/0.png', denoisingStrength: 0.4 } },
      images,
    );

    expect(result.images).toHaveLength(1);
    expect(sent('/sdapi/v1/img2img')).toMatchObject({
      init_images: [Buffer.from(STUB_PNG).toString('base64')],
      denoising_strength: 0.4,
    });
  });

  it('reports ControlNet as unavailable, with a reason, when the extension is not installed', async () => {
    expect((await backend.probe()).unavailable).toEqual([
      {
        feature: 'controlnet',
        reason: 'A1111 に ControlNet の拡張（sd-webui-controlnet）が入っていない',
      },
    ]);
    expect(await backend.listCandidates('controlnetModel')).toEqual([]);
    expect(await backend.listCandidates('controlnetModule')).toEqual([]);
  });

  it('refuses ControlNet units when the extension is not installed, instead of quietly dropping them', async () => {
    const images: GenerationImages = new Map([
      ['refs/r1.png', { data: STUB_PNG, mediaType: 'image/png' }],
    ]);
    await expect(
      generate({ controlnet: [{ image: 'refs/r1.png', model: 'canny' }] }, images),
    ).rejects.toMatchObject({
      kind: 'failed',
      message: 'A1111 に ControlNet の拡張（sd-webui-controlnet）が入っていない',
    });
    expect(a1111.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('names A1111 in the advice when it cannot be reached', async () => {
    const offline = new A1111Backend({ baseUrl: await unusedUrl() });
    const error: unknown = await offline.probe().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).message).toContain('A1111 が起動しているか');
  });
});
