// A1111 の ControlNet の拡張（Mikubill/sd-webui-controlnet）の扱いの試験。
// 偽の A1111 の雛形は、拡張の v1.1.455（コミット 56cec5b）のソースから起こしたもので、実機の応答ではない（fixtures/README.md）
import { generationRequestSchema, type GenerationImages } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { A1111Backend } from './a1111-backend.js';
import { json, startMockA1111, type MockA1111 } from './test-support/mock-a1111.js';

const REF = 'refs/r1.png';
const images: GenerationImages = new Map([
  [REF, { data: Uint8Array.from([4, 5, 6]), mediaType: 'image/png' }],
]);
const b64 = Buffer.from(images.get(REF)!.data).toString('base64');
const base = { prompt: 'a cat', steps: 4, cfgScale: 7, seed: 42, width: 64, height: 64 };
const unit = { image: REF, model: 'control_v11p_sd15_canny [d14c016b]', module: 'canny' };

let a1111: MockA1111;
let backend: A1111Backend;

beforeEach(async () => {
  a1111 = await startMockA1111({ controlnet: true });
  backend = new A1111Backend({ baseUrl: a1111.url });
});

afterEach(async () => {
  await a1111.close();
});

function generate(req: Record<string, unknown>) {
  return backend.generate(
    generationRequestSchema.parse({ ...base, ...req }),
    new AbortController().signal,
    images,
  );
}

function controlnetArgs(path = '/sdapi/v1/txt2img'): Record<string, unknown>[] {
  const request = a1111.requests.find((r) => r.method === 'POST' && r.path === path);
  if (request === undefined) throw new Error(`${path} は呼ばれていない`);
  const body = JSON.parse(request.body) as {
    alwayson_scripts?: { controlnet?: { args: Record<string, unknown>[] } };
  };
  return body.alwayson_scripts!.controlnet!.args;
}

const posted = () => a1111.requests.some((r) => r.method === 'POST');

describe('ControlNet on A1111 with the sd-webui-controlnet extension', () => {
  it('reports ControlNet usable, with the unit count from /controlnet/settings', async () => {
    a1111.route('GET /controlnet/settings', json(200, { control_net_unit_count: 5 }));
    expect(await backend.probe()).toEqual({ unavailable: [], limits: { controlnetUnits: 5 } });
  });

  it('reports ControlNet unavailable when the extension cannot tell its unit count', async () => {
    a1111.route('GET /controlnet/settings', json(404, { detail: 'Not Found' }));
    const { unavailable } = await backend.probe();
    expect(unavailable.map((u) => u.feature)).toEqual(['controlnet']);
    expect(unavailable[0]?.reason).toContain('/controlnet/settings');
  });

  it('lists models with their hash and preprocessors without the extension’s own none', async () => {
    expect(await backend.listCandidates('controlnetModel')).toEqual([
      { name: 'control_v11f1p_sd15_depth [cfd03158]', label: 'control_v11f1p_sd15_depth' },
      { name: 'control_v11p_sd15_canny [d14c016b]', label: 'control_v11p_sd15_canny' },
      { name: 'diffusers_xl_canny_full [2b69fca4]', label: 'diffusers_xl_canny_full' },
    ]);
    expect(await backend.listCandidates('controlnetModule')).toEqual([
      { name: 'canny' },
      { name: 'depth_midas' },
      { name: 'lineart_anime' },
    ]);
  });

  it('sends a unit in the same shape as Forge, filling the unused slots as disabled', async () => {
    await generate({
      controlnet: [{ ...unit, weight: 0.7, controlMode: 'prompt', guidanceEnd: 0.8 }],
    });
    const args = controlnetArgs();
    expect(args[0]).toEqual({
      enabled: true,
      image: b64,
      module: 'canny',
      model: 'control_v11p_sd15_canny [d14c016b]',
      weight: 0.7,
      guidance_start: 0,
      guidance_end: 0.8,
      control_mode: 'My prompt is more important',
      resize_mode: 'Crop and Resize',
      pixel_perfect: false,
      save_detected_map: false,
    });
    expect(args.map((a) => a.enabled)).toEqual([true, false, false]);
  });

  it('sends the extension’s lowercase none when the unit has no preprocessor', async () => {
    await generate({ controlnet: [{ image: REF, model: unit.model }] });
    expect(controlnetArgs()[0]).toMatchObject({ module: 'none' });
  });

  it('applies the unit to both passes of Hires. fix, and to img2img', async () => {
    await generate({
      hiresFix: { upscaler: 'Latent', scale: 1.5, steps: 4, denoisingStrength: 0.5 },
      controlnet: [unit],
    });
    expect(controlnetArgs()[0]).toMatchObject({ hr_option: 'Both' });

    await generate({ img2img: { image: REF, denoisingStrength: 0.5 }, controlnet: [unit] });
    expect(controlnetArgs('/sdapi/v1/img2img')[0]).toMatchObject({ enabled: true, image: b64 });
  });

  it('finds a model by its name without the hash', async () => {
    await generate({ controlnet: [{ ...unit, model: 'control_v11p_sd15_canny' }] });
    expect(controlnetArgs()[0]).toMatchObject({ model: 'control_v11p_sd15_canny [d14c016b]' });
  });

  // 拡張は完全一致で外れると、ファイル名の部分一致で一番短いものを黙って選ぶ（scripts/controlnet.py:76-89）。
  // drawroid が先に引き当てて、部分一致の候補が1つしか無くても断る
  it('refuses a model name that only partly matches, even when just one model contains it', async () => {
    await expect(
      generate({ controlnet: [{ ...unit, model: 'sd15_depth' }] }),
    ).rejects.toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('ControlNet のモデル sd15_depth が A1111 に無い'),
    });
    await expect(generate({ controlnet: [{ ...unit, model: 'canny' }] })).rejects.toMatchObject({
      kind: 'failed',
    });
    expect(posted()).toBe(false);
  });

  it('refuses a preprocessor the extension does not have, and the extension’s own none', async () => {
    for (const module of ['missing', 'none']) {
      await expect(generate({ controlnet: [{ ...unit, module }] })).rejects.toMatchObject({
        kind: 'failed',
        message: expect.stringContaining(`ControlNet の前処理 ${module} が A1111 に無い`),
      });
    }
    expect(posted()).toBe(false);
  });

  it('refuses more units than the extension takes, since A1111 would drop the rest quietly', async () => {
    await expect(generate({ controlnet: [unit, unit, unit, unit] })).rejects.toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('A1111 に載せられる 3 個を超えている'),
    });
    expect(posted()).toBe(false);
  });

  it('refuses a weight above the extension’s limit of 2', async () => {
    await expect(generate({ controlnet: [{ ...unit, weight: 2.5 }] })).rejects.toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('上限 2'),
    });
    await generate({ controlnet: [{ ...unit, weight: 2 }] });
    expect(controlnetArgs()[0]).toMatchObject({ weight: 2 });
  });
});
