import { describe, expect, it } from 'vitest';

import { generationRequestSchema } from './backend.js';

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
