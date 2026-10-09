import { generationRequestSchema, type GenerationRequestInput } from '@drawroid/core';
import { STUB_PNG } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ForgeClient } from './client.js';
import { json, startMockForge, type MockForge } from './test-support/mock-forge.js';
import { generateWithForge } from './txt2img.js';

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
  steps: 20,
  cfgScale: 7,
  width: 512,
  height: 768,
};

function generate(input: Partial<GenerationRequestInput> = {}) {
  return generateWithForge(client, generationRequestSchema.parse({ ...base, ...input }), {
    signal: new AbortController().signal,
    timeoutMs: 5_000,
  });
}

function sentPayload(): Record<string, unknown> {
  const req = forge.requests.find((r) => r.path === '/sdapi/v1/txt2img');
  if (req === undefined) throw new Error('txt2img was not called');
  return JSON.parse(req.body) as Record<string, unknown>;
}

describe('generateWithForge request', () => {
  it('maps the neutral request onto txt2img', async () => {
    await generate({ negativePrompt: 'blurry', sampler: 'Euler a', scheduler: 'karras', seed: 7 });
    expect(sentPayload()).toMatchObject({
      prompt: 'a cat',
      negative_prompt: 'blurry',
      sampler_name: 'Euler a',
      scheduler: 'karras',
      steps: 20,
      cfg_scale: 7,
      seed: 7,
      width: 512,
      height: 768,
      batch_size: 1,
      n_iter: 1,
      save_images: false,
    });
  });

  it('asks Forge for a random seed when the request leaves it out', async () => {
    await generate();
    expect(sentPayload().seed).toBe(-1);
  });

  it('leaves sampler and scheduler to Forge when they are not given', async () => {
    await generate();
    expect(sentPayload()).not.toHaveProperty('sampler_name');
    expect(sentPayload()).not.toHaveProperty('scheduler');
  });

  it('writes LoRAs into the prompt with the Forge syntax', async () => {
    await generate({
      loras: [
        { name: 'watercolor', weight: 0.6 },
        { name: 'detail-tweaker-xl', weight: 1 },
      ],
    });
    expect(sentPayload().prompt).toBe('a cat <lora:watercolor:0.6> <lora:detail-tweaker-xl:1>');
  });

  it('refuses a LoRA name that would break the prompt syntax', async () => {
    await expect(generate({ loras: [{ name: 'bad>name', weight: 1 }] })).rejects.toMatchObject({
      kind: 'failed',
    });
    expect(forge.requests.some((r) => r.path === '/sdapi/v1/txt2img')).toBe(false);
  });

  it('sets the checkpoint for this request only, without touching global options', async () => {
    await generate({ checkpoint: 'animagine-xl-4.0.safetensors [6327eca98b]' });
    expect(sentPayload()).toMatchObject({
      override_settings: { sd_model_checkpoint: 'animagine-xl-4.0.safetensors [6327eca98b]' },
      override_settings_restore_afterwards: true,
    });
    expect(forge.requests.some((r) => r.path === '/sdapi/v1/options')).toBe(false);
  });

  it('refuses a checkpoint Forge does not have, instead of drawing with another model', async () => {
    await expect(generate({ checkpoint: 'no-such-model' })).rejects.toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('no-such-model') as unknown,
    });
    expect(forge.requests.some((r) => r.path === '/sdapi/v1/txt2img')).toBe(false);
  });

  it('passes the VAE as the module file path Forge expects', async () => {
    await generate({ vae: 'sdxl_vae.safetensors' });
    expect(sentPayload()).toMatchObject({
      override_settings: { forge_additional_modules: ['/forge/models/VAE/sdxl_vae.safetensors'] },
    });
  });

  it('turns on Hires. fix with its settings', async () => {
    await generate({
      hiresFix: { upscaler: 'Latent', scale: 1.5, steps: 10, denoisingStrength: 0.4 },
    });
    expect(sentPayload()).toMatchObject({
      enable_hr: true,
      hr_upscaler: 'Latent',
      hr_scale: 1.5,
      hr_second_pass_steps: 10,
      denoising_strength: 0.4,
    });
  });
});

describe('generateWithForge response', () => {
  it('returns each image with the seed Forge actually used and its infotext', async () => {
    const result = await generate({ seed: 100, batchSize: 2 });
    expect(result.images.map((i) => i.seed)).toEqual([100, 101]);
    expect(result.images[1]?.metadata).toEqual({ infotext: 'a cat\nSteps: 4, Seed: 101' });
    expect(result.metadata).toHaveProperty('info');
  });

  it('skips the grid image Forge puts in front of a batch', async () => {
    const png = Buffer.from(STUB_PNG).toString('base64');
    forge.route(
      'POST /sdapi/v1/txt2img',
      json(200, {
        images: [png, png, png],
        info: JSON.stringify({
          all_seeds: [5, 6],
          infotexts: ['grid', 'first', 'second'],
          index_of_first_image: 1,
        }),
      }),
    );
    const result = await generate({ batchSize: 2 });
    expect(result.images.map((i) => i.metadata.infotext)).toEqual(['first', 'second']);
  });

  it('explains how to fix it when Forge returns images that are not PNG', async () => {
    forge.route(
      'POST /sdapi/v1/txt2img',
      json(200, {
        images: [Buffer.from('not a png').toString('base64')],
        info: JSON.stringify({ all_seeds: [1] }),
      }),
    );
    await expect(generate()).rejects.toMatchObject({
      kind: 'bad_response',
      message: expect.stringContaining('samples_format') as unknown,
    });
  });

  it('reports fewer images than asked as a bad response', async () => {
    forge.route(
      'POST /sdapi/v1/txt2img',
      json(200, { images: [], info: JSON.stringify({ all_seeds: [] }) }),
    );
    await expect(generate()).rejects.toMatchObject({ kind: 'bad_response' });
  });
});
