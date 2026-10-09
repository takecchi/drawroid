import { describe, expect, it } from 'vitest';

import { buildGenerationRequest, DEFAULT_FORM_VALUES } from './generation-form';

describe('buildGenerationRequest', () => {
  it('builds a request from the defaults, omitting every empty field', () => {
    expect(buildGenerationRequest({ ...DEFAULT_FORM_VALUES, prompt: 'a cat' })).toEqual({
      prompt: 'a cat',
      steps: 20,
      cfgScale: 7,
      width: 512,
      height: 512,
      batchSize: 1,
    });
  });

  it('converts numeric text to numbers and keeps the chosen candidates', () => {
    expect(
      buildGenerationRequest({
        ...DEFAULT_FORM_VALUES,
        prompt: 'a cat',
        negativePrompt: 'blurry',
        checkpoint: 'anime.safetensors',
        vae: 'vae.safetensors',
        sampler: 'Euler a',
        scheduler: 'Karras',
        steps: '30',
        cfgScale: '5.5',
        width: '768',
        height: '1024',
        seed: '42',
        batchSize: '4',
      }),
    ).toEqual({
      prompt: 'a cat',
      negativePrompt: 'blurry',
      checkpoint: 'anime.safetensors',
      vae: 'vae.safetensors',
      sampler: 'Euler a',
      scheduler: 'Karras',
      steps: 30,
      cfgScale: 5.5,
      width: 768,
      height: 1024,
      seed: 42,
      batchSize: 4,
    });
  });

  it('keeps seed 0 instead of treating it as empty', () => {
    expect(buildGenerationRequest({ ...DEFAULT_FORM_VALUES, seed: '0' }).seed).toBe(0);
  });

  it('weights each LoRA, defaulting an empty weight to 1', () => {
    const request = buildGenerationRequest({
      ...DEFAULT_FORM_VALUES,
      loras: [
        { name: 'a', weight: '0.8' },
        { name: 'b', weight: '' },
      ],
    });
    expect(request.loras).toEqual([
      { name: 'a', weight: 0.8 },
      { name: 'b', weight: 1 },
    ]);
  });

  it('does not silently drop a seed that is not a number', () => {
    expect(buildGenerationRequest({ ...DEFAULT_FORM_VALUES, seed: 'abc' }).seed).toBeNaN();
  });
});
