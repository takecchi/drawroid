import { describe, expect, it } from 'vitest';

import { BackendError, isBackendError } from './backend-error.js';
import { candidateSchema, generationRequestSchema, inputImageRefsOf } from './backend.js';

const base = { prompt: 'a', steps: 20, cfgScale: 7, width: 64, height: 64 };

describe('generationRequestSchema', () => {
  it('fills in the defaults for the optional lists and counts', () => {
    const req = generationRequestSchema.parse({
      prompt: 'a cat',
      steps: 20,
      cfgScale: 7,
      width: 512,
      height: 512,
    });
    expect(req).toMatchObject({ negativePrompt: '', loras: [], batchSize: 1 });
    expect(req.seed).toBeUndefined();
  });

  it('rejects a request without a size', () => {
    expect(() => generationRequestSchema.parse({ prompt: 'a', steps: 20, cfgScale: 7 })).toThrow();
  });

  it('rejects a negative seed', () => {
    expect(() =>
      generationRequestSchema.parse({
        prompt: 'a',
        steps: 20,
        cfgScale: 7,
        width: 64,
        height: 64,
        seed: -1,
      }),
    ).toThrow();
  });
});

describe('generationRequestSchema bounds', () => {
  it('rejects zero steps', () => {
    expect(() => generationRequestSchema.parse({ ...base, steps: 0 })).toThrow();
  });

  it.each([-0.1, 1.1])('rejects a Hires. fix denoising strength of %s, outside 0 to 1', (value) => {
    const hiresFix = { upscaler: 'Latent', scale: 2, steps: 10, denoisingStrength: value };
    expect(() => generationRequestSchema.parse({ ...base, hiresFix })).toThrow();
  });
});

describe('candidateSchema', () => {
  it('rejects a candidate without a name, since a request could not point at it', () => {
    expect(() => candidateSchema.parse({ name: '' })).toThrow();
  });
});

describe('isBackendError', () => {
  it('tells a backend error from any other error, so only backend failures carry a kind', () => {
    expect(isBackendError(new BackendError('unreachable', 'x'))).toBe(true);
    expect(isBackendError(new Error('x'))).toBe(false);
    expect(isBackendError({ kind: 'unreachable', message: 'x' })).toBe(false);
  });
});

describe('generationRequestSchema for image inputs', () => {
  const base = { prompt: 'a cat', steps: 20, cfgScale: 7, width: 512, height: 512 };

  it('fills in the inpaint settings the way the Forge and A1111 screens start out', () => {
    const req = generationRequestSchema.parse({
      ...base,
      inpaint: {
        image: 'iterations/0002/images/1.png',
        mask: 'masks/m1.png',
        denoisingStrength: 0.6,
      },
    });

    expect(req.inpaint).toMatchObject({
      fill: 'original',
      area: 'whole',
      maskBlur: 4,
      padding: 32,
    });
  });

  it('refuses img2img and inpaint together, since inpaint already has its source image', () => {
    const result = generationRequestSchema.safeParse({
      ...base,
      img2img: { image: 'a.png', denoisingStrength: 0.5 },
      inpaint: { image: 'a.png', mask: 'm.png', denoisingStrength: 0.5 },
    });

    expect(result.success).toBe(false);
  });

  it('refuses a ControlNet unit that stops guiding before it starts', () => {
    const result = generationRequestSchema.safeParse({
      ...base,
      controlnet: [{ image: 'refs/r1.png', model: 'canny', guidanceStart: 0.8, guidanceEnd: 0.2 }],
    });

    expect(result.success).toBe(false);
  });

  it('leaves ControlNet off unless units are given', () => {
    expect(generationRequestSchema.parse(base).controlnet).toEqual([]);
  });
});

describe('inputImageRefsOf', () => {
  it('lists every image the request points at, once each', () => {
    const req = generationRequestSchema.parse({
      prompt: 'a cat',
      steps: 20,
      cfgScale: 7,
      width: 512,
      height: 512,
      inpaint: {
        image: 'iterations/0002/images/1.png',
        mask: 'masks/m1.png',
        denoisingStrength: 0.6,
      },
      controlnet: [
        { image: 'refs/r1.png', model: 'canny [0123abcd]' },
        { image: 'iterations/0002/images/1.png', model: 'depth [4567efgh]' },
      ],
    });

    expect(inputImageRefsOf(req).sort()).toEqual([
      'iterations/0002/images/1.png',
      'masks/m1.png',
      'refs/r1.png',
    ]);
  });

  it('lists nothing for a plain txt2img request', () => {
    const req = generationRequestSchema.parse({
      prompt: 'a cat',
      steps: 20,
      cfgScale: 7,
      width: 512,
      height: 512,
    });

    expect(inputImageRefsOf(req)).toEqual([]);
  });
});
