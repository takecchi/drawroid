// manualGenerationRequestSchema の TSDoc（img2img・inpaint・ControlNet は断り、画像を指さない要求は通す）の境目（#58 の 30-09・30-10）
import { describe, expect, it } from 'vitest';

import { manualGenerationRequestSchema } from './manual.js';

const base = { prompt: 'a cat', steps: 4, cfgScale: 7, width: 64, height: 64 };

describe('manualGenerationRequestSchema', () => {
  it('refuses an inpaint-only request and a ControlNet-only request, as well as img2img', () => {
    for (const pointing of [
      { img2img: { image: 'iterations/0001/images/0.png', denoisingStrength: 0.5 } },
      {
        inpaint: {
          image: 'iterations/0001/images/0.png',
          mask: 'masks/m1.png',
          denoisingStrength: 0.5,
        },
      },
      { controlnet: [{ image: 'refs/r1.png', model: 'canny' }] },
    ]) {
      expect(manualGenerationRequestSchema.safeParse({ ...base, ...pointing }).success).toBe(false);
    }
  });

  it('accepts a request with Hires. fix, since it points at no image', () => {
    const parsed = manualGenerationRequestSchema.safeParse({
      ...base,
      hiresFix: { upscaler: 'Latent', scale: 1.5, steps: 10, denoisingStrength: 0.5 },
    });
    expect(parsed.success).toBe(true);
  });
});
