// backend.ts の公開の値が TSDoc・列挙のとおりであること（#58 の 30-03・30-13・30-14〜16）
import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_KIND_FEATURE,
  CONTROL_MODES,
  controlNetUnitSchema,
  generationRequestSchema,
  INPAINT_FILLS,
  inpaintSchema,
  inputImageRefsOf,
  RESIZE_MODES,
  resizeModeSchema,
} from './backend.js';

const base = { prompt: 'a cat', steps: 4, cfgScale: 7, width: 64, height: 64 };

describe('inputImageRefsOf', () => {
  it('lists both the image and the mask of an inpaint-only request', () => {
    const req = generationRequestSchema.parse({
      ...base,
      inpaint: {
        image: 'iterations/0001/images/0.png',
        mask: 'masks/m1.png',
        denoisingStrength: 0.5,
      },
    });
    expect(inputImageRefsOf(req)).toEqual(['iterations/0001/images/0.png', 'masks/m1.png']);
  });
});

describe('CANDIDATE_KIND_FEATURE', () => {
  it('ties the upscaler to Hires. fix and both ControlNet kinds to ControlNet, and nothing else', () => {
    expect(CANDIDATE_KIND_FEATURE).toEqual({
      upscaler: 'hiresFix',
      controlnetModel: 'controlnet',
      controlnetModule: 'controlnet',
    });
  });
});

describe('the listed values', () => {
  it('accepts every resize mode it lists', () => {
    expect(RESIZE_MODES).toEqual(['stretch', 'crop', 'fill']);
    for (const mode of RESIZE_MODES) expect(resizeModeSchema.parse(mode)).toBe(mode);
  });

  it('accepts every inpaint fill it lists', () => {
    expect(INPAINT_FILLS).toEqual(['original', 'fill', 'latentNoise', 'latentNothing']);
    for (const fill of INPAINT_FILLS) {
      expect(
        inpaintSchema.parse({ image: 'a.png', mask: 'm.png', denoisingStrength: 0.5, fill }).fill,
      ).toBe(fill);
    }
  });

  it('accepts every control mode it lists', () => {
    expect(CONTROL_MODES).toEqual(['balanced', 'prompt', 'controlnet']);
    for (const controlMode of CONTROL_MODES) {
      expect(
        controlNetUnitSchema.parse({ image: 'r.png', model: 'canny', controlMode }).controlMode,
      ).toBe(controlMode);
    }
  });
});
