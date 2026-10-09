import {
  type GenerationImages,
  generationRequestSchema,
  type GenerationRequestInput,
} from '@drawroid/core';
import { STUB_PNG } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ForgeClient } from './client.js';
import { generateWithForge } from './generate.js';
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

const base: GenerationRequestInput = {
  prompt: 'a cat',
  negativePrompt: 'blurry',
  steps: 20,
  cfgScale: 7,
  width: 512,
  height: 768,
};

const SOURCE = 'iterations/0001/images/0.png';
const MASK = 'masks/m1.png';
const REF = 'refs/r1.png';
const images: GenerationImages = new Map([
  [SOURCE, { data: STUB_PNG, mediaType: 'image/png' }],
  [MASK, { data: Uint8Array.from([1, 2, 3]), mediaType: 'image/png' }],
  [REF, { data: Uint8Array.from([4, 5, 6]), mediaType: 'image/png' }],
]);
const b64 = (ref: string) => Buffer.from(images.get(ref)!.data).toString('base64');

function generate(input: Partial<GenerationRequestInput> = {}, with_ = images) {
  return generateWithForge(client, generationRequestSchema.parse({ ...base, ...input }), {
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    images: with_,
  });
}

function sent(path: string): Record<string, unknown> {
  const req = forge.requests.find((r) => r.path === path);
  if (req === undefined) throw new Error(`${path} was not called`);
  return JSON.parse(req.body) as Record<string, unknown>;
}

const called = (path: string) => forge.requests.some((r) => r.path === path);

function controlnetArgs(path = '/sdapi/v1/txt2img'): Record<string, unknown>[] {
  const scripts = sent(path).alwayson_scripts as Record<
    string,
    { args: Record<string, unknown>[] }
  >;
  return scripts.controlnet!.args;
}

describe('img2img and inpaint on Forge', () => {
  it('sends img2img to the img2img endpoint with the source image as plain base64', async () => {
    await generate({ img2img: { image: SOURCE, denoisingStrength: 0.45, resize: 'crop' } });

    expect(called('/sdapi/v1/txt2img')).toBe(false);
    expect(sent('/sdapi/v1/img2img')).toMatchObject({
      prompt: 'a cat',
      init_images: [b64(SOURCE)],
      denoising_strength: 0.45,
      resize_mode: 1,
      include_init_images: false,
      save_images: false,
    });
  });

  it('spells out how to fill and how much to repaint, instead of leaving the API defaults that differ from the screen', async () => {
    await generate({ inpaint: { image: SOURCE, mask: MASK, denoisingStrength: 0.6 } });

    expect(sent('/sdapi/v1/img2img')).toMatchObject({
      init_images: [b64(SOURCE)],
      mask: b64(MASK),
      inpainting_mask_invert: 0,
      inpainting_fill: 1,
      inpaint_full_res: false,
      inpaint_full_res_padding: 32,
      mask_blur: 4,
    });
  });

  it('repaints only around the mask when asked to', async () => {
    await generate({
      inpaint: {
        image: SOURCE,
        mask: MASK,
        denoisingStrength: 0.6,
        area: 'masked',
        fill: 'latentNoise',
      },
    });

    expect(sent('/sdapi/v1/img2img')).toMatchObject({ inpaint_full_res: true, inpainting_fill: 2 });
  });

  it('sends the repaint strength asked for in an inpaint', async () => {
    await generate({ inpaint: { image: SOURCE, mask: MASK, denoisingStrength: 0.35 } });

    expect(sent('/sdapi/v1/img2img')).toMatchObject({ denoising_strength: 0.35 });
  });

  it('refuses img2img with Hires. fix, which the img2img endpoint would silently ignore', async () => {
    await expect(
      generate({
        img2img: { image: SOURCE, denoisingStrength: 0.5 },
        hiresFix: { upscaler: 'Latent', scale: 2, steps: 0, denoisingStrength: 0.5 },
      }),
    ).rejects.toMatchObject({ kind: 'failed' });
    expect(called('/sdapi/v1/img2img')).toBe(false);
  });

  it('refuses before asking Forge anything when the content of an image is missing', async () => {
    await expect(
      generate({ img2img: { image: SOURCE, denoisingStrength: 0.5 } }, new Map()),
    ).rejects.toMatchObject({
      kind: 'failed',
      message: expect.stringContaining(SOURCE) as unknown,
    });
    expect(forge.requests).toEqual([]);
  });
});

describe('checking the images before asking Forge', () => {
  it('asks Forge nothing when only the image of a ControlNet unit is missing', async () => {
    const withoutRef: GenerationImages = new Map([...images].filter(([ref]) => ref !== REF));
    await expect(
      generate(
        { controlnet: [{ image: REF, model: 'diffusers_xl_canny_full [2b69fca4]' }] },
        withoutRef,
      ),
    ).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining(REF) as unknown });
    expect(forge.requests).toEqual([]);
  });
});

describe('Hires. fix and LoRA details on Forge', () => {
  const hires = { upscaler: 'Latent', scale: 2, steps: 0, denoisingStrength: 0.5 };

  it('sends the CFG for the second pass, so Forge does not drop the negative prompt there', async () => {
    await generate({ hiresFix: hires });

    expect(sent('/sdapi/v1/txt2img')).toMatchObject({ hr_cfg: 7 });
  });

  it('maps the second-pass settings, keeping the LoRAs in the second-pass prompt', async () => {
    await generate({
      loras: [{ name: 'detail-tweaker-xl', weight: 0.6 }],
      hiresFix: {
        ...hires,
        checkpoint: 'real/juggernaut-xl.safetensors',
        sampler: 'DPM++ 2M',
        scheduler: 'karras',
        prompt: 'a cat, detailed fur',
        negativePrompt: 'lowres',
        cfgScale: 5,
      },
    });

    expect(sent('/sdapi/v1/txt2img')).toMatchObject({
      hr_checkpoint_name: 'real/juggernaut-xl.safetensors',
      hr_sampler_name: 'DPM++ 2M',
      hr_scheduler: 'karras',
      hr_prompt: 'a cat, detailed fur <lora:detail-tweaker-xl:0.6>',
      hr_negative_prompt: 'lowres',
      hr_cfg: 5,
    });
  });

  it('leaves the second-pass sampler and scheduler out when they should stay the same', async () => {
    await generate({ hiresFix: hires });

    expect(sent('/sdapi/v1/txt2img')).not.toHaveProperty('hr_sampler_name');
    expect(sent('/sdapi/v1/txt2img')).not.toHaveProperty('hr_scheduler');
  });

  it('writes a separate UNet weight as the third value of the LoRA tag', async () => {
    await generate({ loras: [{ name: 'detail-tweaker-xl', weight: 0.8, unetWeight: 0.5 }] });

    expect(sent('/sdapi/v1/txt2img').prompt).toBe('a cat <lora:detail-tweaker-xl:0.8:0.5>');
  });
});

describe('ControlNet on Forge', () => {
  const unit = { image: REF, model: 'diffusers_xl_canny_full [2b69fca4]', module: 'canny' };

  it('passes a unit as the dict Forge reads, with its modes spelled as Forge compares them', async () => {
    await generate({
      controlnet: [{ ...unit, weight: 0.7, controlMode: 'prompt', guidanceEnd: 0.8 }],
    });

    expect(controlnetArgs()[0]).toEqual({
      enabled: true,
      image: b64(REF),
      module: 'canny',
      model: 'diffusers_xl_canny_full [2b69fca4]',
      weight: 0.7,
      guidance_start: 0,
      guidance_end: 0.8,
      control_mode: 'My prompt is more important',
      resize_mode: 'Crop and Resize',
      pixel_perfect: false,
      save_detected_map: false,
    });
  });

  it('sends each unit its own image', async () => {
    await generate({ controlnet: [unit, { ...unit, image: SOURCE }] });

    expect(controlnetArgs().map((a) => a.image)).toEqual([b64(REF), b64(SOURCE), undefined]);
  });

  it('marks the unit slots it does not use as disabled', async () => {
    await generate({ controlnet: [unit] });

    expect(controlnetArgs().map((a) => a.enabled)).toEqual([true, false, false]);
  });

  it('uses the image as it is, with Forge\'s own "None" preprocessor, when no module is given', async () => {
    await generate({ controlnet: [{ image: REF, model: unit.model }] });

    expect(controlnetArgs()[0]).toMatchObject({ module: 'None' });
  });

  it('works with img2img too, through the same scripts field', async () => {
    await generate({ img2img: { image: SOURCE, denoisingStrength: 0.5 }, controlnet: [unit] });

    expect(controlnetArgs('/sdapi/v1/img2img')[0]).toMatchObject({
      enabled: true,
      module: 'canny',
    });
  });

  it('asks for the unit to apply to both passes when Hires. fix is on', async () => {
    await generate({
      hiresFix: { upscaler: 'Latent', scale: 2, steps: 0, denoisingStrength: 0.5 },
      controlnet: [unit],
    });

    expect(controlnetArgs()[0]).toMatchObject({ hr_option: 'Both' });
  });

  it('finds a model given without its hash, since Forge only matches the full name', async () => {
    await generate({ controlnet: [{ ...unit, model: 'diffusers_xl_canny_full' }] });

    expect(controlnetArgs()[0]).toMatchObject({ model: 'diffusers_xl_canny_full [2b69fca4]' });
  });

  it('refuses a model or preprocessor Forge does not have, before generating', async () => {
    await expect(generate({ controlnet: [{ ...unit, model: 'missing' }] })).rejects.toMatchObject({
      kind: 'failed',
    });
    await expect(generate({ controlnet: [{ ...unit, module: 'none' }] })).rejects.toMatchObject({
      kind: 'failed',
    });
    expect(called('/sdapi/v1/txt2img')).toBe(false);
  });

  it('refuses more units than Forge takes, instead of letting Forge drop the extra ones', async () => {
    await expect(generate({ controlnet: [unit, unit, unit, unit] })).rejects.toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('4') as unknown,
    });
    expect(called('/sdapi/v1/txt2img')).toBe(false);
  });

  it('refuses when Forge has not loaded ControlNet', async () => {
    forge.route('GET /sdapi/v1/scripts', json(200, { txt2img: ['lora'], img2img: ['lora'] }));

    await expect(generate({ controlnet: [unit] })).rejects.toMatchObject({ kind: 'failed' });
    expect(called('/sdapi/v1/txt2img')).toBe(false);
  });

  it('returns only the generated images when Forge appends other images after them', async () => {
    const png = Buffer.from(STUB_PNG).toString('base64');
    forge.route(
      'POST /sdapi/v1/txt2img',
      json(200, {
        images: [png, png, Buffer.from('detected map').toString('base64')],
        info: JSON.stringify({ all_seeds: [1, 2], index_of_first_image: 0 }),
      }),
    );

    const result = await generate({ batchSize: 2, controlnet: [unit] });

    expect(result.images).toHaveLength(2);
  });
});
