import { describe, expect, it } from 'vitest';

import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import { toGenerationRequest } from './generation-request.js';
import { mergePermissions, type Permissions } from './permission.js';

const allAuto = (): Permissions =>
  Object.fromEntries(PARAM_KEYS.map((key) => [key, { mode: 'auto' }])) as Record<
    ParamKey,
    { mode: 'auto' }
  >;

const decidedByAi = {
  prompt: '1girl, beach, sunset',
  negativePrompt: 'lowres',
  checkpoint: 'animeMix',
  steps: 20,
  cfgScale: 7,
  seed: 42,
  width: 832,
  height: 1216,
};

describe('toGenerationRequest', () => {
  it('generates with what the AI decided for the parameters left to it', () => {
    const request = toGenerationRequest({
      decided: decidedByAi,
      permissions: allAuto(),
      batchSize: 2,
    });

    expect(request).toMatchObject({ ...decidedByAi, batchSize: 2 });
  });

  it.each([
    ['a different value', 50],
    ['a value out of range', -3],
    ['a value of the wrong type', 'many'],
    ['nothing', undefined],
  ])('generates with the fixed value whatever the AI returned, even %s (M4:118)', (_, steps) => {
    const permissions = mergePermissions(allAuto(), {
      steps: { mode: 'fixed', value: 28 },
      checkpoint: { mode: 'fixed', value: 'realisticVision' },
      hiresFix: {
        mode: 'fixed',
        value: { upscaler: 'Latent', scale: 1.5, steps: 10, denoisingStrength: 0.5 },
      },
    });

    const request = toGenerationRequest({
      decided: {
        ...decidedByAi,
        steps,
        checkpoint: 'animeMix',
        hiresFix: { upscaler: 'ESRGAN', scale: 4, steps: 99, denoisingStrength: 1 },
      },
      permissions,
      batchSize: 1,
    });

    expect(request.steps).toBe(28);
    expect(request.checkpoint).toBe('realisticVision');
    expect(request.hiresFix).toEqual({
      upscaler: 'Latent',
      scale: 1.5,
      steps: 10,
      denoisingStrength: 0.5,
    });
  });

  it('leaves a parameter that is not used to the backend, even if the AI returned it', () => {
    const request = toGenerationRequest({
      decided: { ...decidedByAi, vae: 'kl-f8-anime', loras: [{ name: 'detail', weight: 0.8 }] },
      permissions: mergePermissions(allAuto(), { vae: { mode: 'off' }, loras: { mode: 'off' } }),
      batchSize: 1,
    });

    expect(request.vae).toBeUndefined();
    expect(request.loras).toEqual([]);
  });

  it('ignores what the AI returned outside the generation parameters', () => {
    const request = toGenerationRequest({
      decided: { ...decidedByAi, batchSize: 64, rationale: '逆光にする' },
      permissions: allAuto(),
      batchSize: 1,
    });

    expect(request.batchSize).toBe(1);
    expect(request).not.toHaveProperty('rationale');
  });

  it('refuses to generate with a fixed value the backend cannot take', () => {
    expect(() =>
      toGenerationRequest({
        decided: decidedByAi,
        permissions: mergePermissions(allAuto(), { steps: { mode: 'fixed', value: 0 } }),
        batchSize: 1,
      }),
    ).toThrow();
  });
});
