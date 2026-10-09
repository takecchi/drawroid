import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_BUDGET } from '../loop/budget.js';
import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import {
  effectivePermissions,
  type Permission,
  type Permissions,
} from '../permissions/permission.js';
import { buildParamsSchema, type ParamsSchemaContext, parseParams } from './params-schema.js';

const permissionsWith = (mode: (key: ParamKey) => Permission): Permissions =>
  Object.fromEntries(PARAM_KEYS.map((key) => [key, mode(key)])) as Permissions;
const allOff = () => permissionsWith(() => ({ mode: 'off' }));
const allAuto = () => permissionsWith(() => ({ mode: 'auto' }));

const context: ParamsSchemaContext = {
  shown: {
    checkpoint: [{ name: 'animeMix' }, { name: 'realVision' }],
    lora: [{ name: 'watercolor', note: '水彩の質感' }],
    sampler: [{ name: 'Euler a' }],
    scheduler: [{ name: 'Karras' }],
    vae: [{ name: 'sdxl_vae' }],
  },
  budget: { ...DEFAULT_BUDGET, text: { ...DEFAULT_BUDGET.text, prompt: 40 } },
};

const jsonSchemaKeys = (schema: z.ZodType) =>
  Object.keys((z.toJSONSchema(schema) as { properties?: object }).properties ?? {}).sort();

describe('buildParamsSchema', () => {
  it('leaves parameters that are fixed or off out of the schema the AI sees', () => {
    const permissions = {
      ...allOff(),
      prompt: { mode: 'auto' },
      checkpoint: { mode: 'auto' },
      steps: { mode: 'fixed', value: 28 },
      seed: { mode: 'fixed', value: 1 },
    } satisfies Permissions;

    const { schema } = buildParamsSchema(permissions, context);

    expect(jsonSchemaKeys(schema)).toEqual(['checkpoint', 'prompt']);
  });

  it('has no parameters at all when nothing is left to the AI', () => {
    const { schema } = buildParamsSchema(allOff(), context);

    expect(jsonSchemaKeys(schema)).toEqual([]);
  });

  it('does not let a value for a parameter the AI was not given through', () => {
    const permissions = {
      ...allOff(),
      prompt: { mode: 'auto' },
      steps: { mode: 'fixed', value: 28 },
    } satisfies Permissions;
    const { schema } = buildParamsSchema(permissions, context);

    const parsed = schema.parse({ prompt: '夕暮れの海辺', steps: 80, cfgScale: 30 });

    expect(parsed).toEqual({ prompt: '夕暮れの海辺' });
  });

  it('accepts only the candidates that were shown to the AI', () => {
    const permissions = {
      ...allOff(),
      checkpoint: { mode: 'auto' },
      loras: { mode: 'auto' },
    } satisfies Permissions;
    const { schema } = buildParamsSchema(permissions, context);

    expect(
      schema.safeParse({ checkpoint: 'animeMix', loras: [{ name: 'watercolor', weight: 0.6 }] })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ checkpoint: 'notShownModel', loras: [] }).success).toBe(false);
    expect(
      schema.safeParse({ checkpoint: 'animeMix', loras: [{ name: 'notShownLora', weight: 1 }] })
        .success,
    ).toBe(false);
  });

  it('asks for one weight per LoRA, without a separate UNet weight, to keep the output short', () => {
    const permissions = { ...allOff(), loras: { mode: 'auto' } } satisfies Permissions;
    const { schema } = buildParamsSchema(permissions, context);

    const json = z.toJSONSchema(schema) as unknown as {
      properties: { loras: { items: { properties: object } } };
    };
    expect(Object.keys(json.properties.loras.items.properties).sort()).toEqual(['name', 'weight']);
  });

  it('reports a candidate parameter it could not offer because no candidate was shown', () => {
    const permissions = { ...allOff(), checkpoint: { mode: 'auto' } } satisfies Permissions;

    const { schema, omitted } = buildParamsSchema(permissions, { ...context, shown: {} });

    expect(jsonSchemaKeys(schema)).toEqual([]);
    expect(omitted).toEqual({ checkpoint: 'no-candidates-shown' });
  });

  it('rejects a prompt longer than the output limit', () => {
    const permissions = { ...allOff(), prompt: { mode: 'auto' } } satisfies Permissions;
    const { schema } = buildParamsSchema(permissions, context);

    expect(schema.safeParse({ prompt: 'あ'.repeat(41) }).success).toBe(false);
  });

  it('does not offer inpaint while there is no mask', () => {
    const { permissions } = effectivePermissions(allAuto(), {
      capabilities: { unavailable: [] },
      hasMask: false,
    });

    const { schema, omitted } = buildParamsSchema(permissions, context);

    expect(jsonSchemaKeys(schema)).not.toContain('inpaint');
    expect(omitted.inpaint).toBeUndefined();
  });

  it('does not offer a parameter the backend cannot use', () => {
    const { permissions } = effectivePermissions(allAuto(), {
      capabilities: { unavailable: [{ feature: 'inpaint', reason: 'inpaint に対応していない' }] },
      hasMask: true,
    });

    const { schema, omitted } = buildParamsSchema(permissions, context);

    expect(jsonSchemaKeys(schema)).not.toContain('inpaint');
    expect(omitted.inpaint).toBeUndefined();
  });

  it('keeps ControlNet out until there is a way to offer its choices', () => {
    const { schema, omitted } = buildParamsSchema(allAuto(), context);

    expect(jsonSchemaKeys(schema)).not.toContain('controlnet');
    expect(omitted.controlnet).toBe('not-supported-yet');
  });
});

describe('buildParamsSchema for image inputs', () => {
  const img2imgOnly = { ...allOff(), img2img: { mode: 'auto' } } satisfies Permissions;

  it('offers img2img only with the image keys that were shown, as an enum (Issue #5 G)', () => {
    const { schema } = buildParamsSchema(img2imgOnly, {
      ...context,
      imageSources: ['best', 'ref:0001'],
    });

    expect(
      schema.safeParse({ img2img: { image: 'ref:0001', denoisingStrength: 0.5 } }).success,
    ).toBe(true);
    expect(schema.safeParse({ img2img: { image: 'latest', denoisingStrength: 0.5 } }).success).toBe(
      false,
    );
  });

  it('does not offer img2img when no image was shown to start from', () => {
    const { schema, omitted } = buildParamsSchema(img2imgOnly, context);

    expect(jsonSchemaKeys(schema)).not.toContain('img2img');
    expect(omitted.img2img).toBe('no-candidates-shown');
  });

  it('lets the AI decide only how strongly to repaint, since the human chose the image and the mask', () => {
    const permissions = { ...allOff(), inpaint: { mode: 'auto' } } satisfies Permissions;
    const { schema } = buildParamsSchema(permissions, context);

    const json = z.toJSONSchema(schema) as unknown as {
      properties: { inpaint: { properties: object } };
    };
    expect(Object.keys(json.properties.inpaint.properties)).toEqual(['denoisingStrength']);
  });
});

describe('buildParamsSchema for Hires. fix', () => {
  const permissions = { ...allOff(), hiresFix: { mode: 'auto' } } satisfies Permissions;
  const withUpscalers: ParamsSchemaContext = {
    ...context,
    shown: { ...context.shown, upscaler: [{ name: 'Latent' }, { name: 'R-ESRGAN 4x+' }] },
  };
  const hires = { upscaler: 'Latent', scale: 1.5, steps: 0, denoisingStrength: 0.5 };

  it('offers Hires. fix with only the upscalers that were shown', () => {
    const { schema } = buildParamsSchema(permissions, withUpscalers);

    expect(schema.safeParse({ hiresFix: hires }).success).toBe(true);
    expect(schema.safeParse({ hiresFix: { ...hires, upscaler: 'SwinIR_4x' } }).success).toBe(false);
  });

  it('keeps the upscale within the range the screens offer', () => {
    const { schema } = buildParamsSchema(permissions, withUpscalers);

    expect(schema.safeParse({ hiresFix: { ...hires, scale: 8 } }).success).toBe(false);
  });

  it('does not offer Hires. fix when no upscaler was shown', () => {
    const { schema, omitted } = buildParamsSchema(permissions, context);

    expect(jsonSchemaKeys(schema)).not.toContain('hiresFix');
    expect(omitted.hiresFix).toBe('no-candidates-shown');
  });
});

describe('parseParams', () => {
  it('names the fields it threw away because the AI was not given them', () => {
    const permissions = {
      ...allOff(),
      prompt: { mode: 'auto' },
      steps: { mode: 'fixed', value: 28 },
    } satisfies Permissions;

    const { result, droppedKeys } = parseParams(buildParamsSchema(permissions, context), {
      prompt: '夕暮れの海辺',
      steps: 80,
      thoughts: '...',
    });

    expect(result.success && result.data).toEqual({ prompt: '夕暮れの海辺' });
    expect(droppedKeys.sort()).toEqual(['steps', 'thoughts']);
  });

  it('reports nothing dropped when the AI returns only what it was given', () => {
    const permissions = { ...allOff(), prompt: { mode: 'auto' } } satisfies Permissions;

    const { droppedKeys } = parseParams(buildParamsSchema(permissions, context), { prompt: '海' });

    expect(droppedKeys).toEqual([]);
  });
});

describe('buildParamsSchema with a seed left to the AI', () => {
  it('requires the AI to choose a seed instead of leaving it to the backend', () => {
    const permissions = { ...allOff(), seed: { mode: 'auto' } } satisfies Permissions;
    const { schema } = buildParamsSchema(permissions, context);

    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ seed: 42 }).success).toBe(true);
  });
});

describe('buildParamsSchema with numbers left to the AI', () => {
  it('keeps numbers within the bounds the input budget is estimated with', () => {
    const permissions = {
      ...allOff(),
      seed: { mode: 'auto' },
      steps: { mode: 'auto' },
      cfgScale: { mode: 'auto' },
    } satisfies Permissions;
    const { schema } = buildParamsSchema(permissions, context);
    const worst = { seed: 4294967295, steps: 150, cfgScale: 30 };

    expect(schema.safeParse(worst).success).toBe(true);
    expect(schema.safeParse({ ...worst, seed: 4294967296 }).success).toBe(false);
    expect(schema.safeParse({ ...worst, steps: 151 }).success).toBe(false);
    expect(schema.safeParse({ ...worst, cfgScale: 31 }).success).toBe(false);
  });
});
