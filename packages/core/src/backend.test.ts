import { describe, expect, it } from 'vitest';

import { BackendError, isBackendError } from './backend-error.js';
import { candidateSchema, generationRequestSchema } from './backend.js';

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
