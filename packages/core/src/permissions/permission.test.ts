import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { generationRequestSchema } from '../backend.js';
import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import {
  describePermissionIssue,
  effectivePermissions,
  mergePermissions,
  permissionOverridesSchema,
  permissionSchema,
  permissionsSchema,
  readPermissionOverrides,
  REQUIRED_PARAM_KEYS,
  type Permissions,
} from './permission.js';

const allAuto = (): Permissions =>
  Object.fromEntries(PARAM_KEYS.map((key) => [key, { mode: 'auto' }])) as Record<
    ParamKey,
    { mode: 'auto' }
  >;
// 生成の要求の各欄に合う値。固定の値は、要求の該当する欄と同じ形でなければならない
const FIXED_SAMPLES: Record<ParamKey, unknown> = {
  prompt: 'girl, beach',
  negativePrompt: 'lowres',
  checkpoint: 'animeMix.safetensors',
  vae: 'vae.pt',
  loras: [{ name: 'detail', weight: 0.6 }],
  sampler: 'Euler a',
  scheduler: 'Karras',
  steps: 28,
  cfgScale: 6.5,
  seed: 1234,
  width: 512,
  height: 768,
  hiresFix: { upscaler: 'Latent', scale: 2, steps: 0, denoisingStrength: 0.5 },
  img2img: { image: 'refs/r1.png', denoisingStrength: 0.5 },
  inpaint: { image: 'refs/r1.png', mask: 'masks/m1.png', denoisingStrength: 0.75 },
  controlnet: [{ image: 'refs/r1.png', model: 'canny' }],
};
const nothingMissing = { capabilities: { unavailable: [] }, hasMask: true };

describe('mergePermissions', () => {
  it('lets the job override the global default parameter by parameter', () => {
    const merged = mergePermissions(allAuto(), {
      steps: { mode: 'fixed', value: 28 },
      vae: { mode: 'off' },
    });

    expect(merged.steps).toEqual({ mode: 'fixed', value: 28 });
    expect(merged.vae).toEqual({ mode: 'off' });
    expect(merged.checkpoint).toEqual({ mode: 'auto' });
  });
});

describe('effectivePermissions', () => {
  it('keeps the job permissions as they are when the backend supports everything and a mask exists', () => {
    const job = mergePermissions(allAuto(), { seed: { mode: 'fixed', value: 1 } });

    const { permissions, disabled } = effectivePermissions(job, nothingMissing);

    expect(permissions).toEqual(job);
    expect(disabled).toEqual({});
  });

  it('turns off a parameter the backend cannot use, with the reason, whatever the job allowed', () => {
    const job = mergePermissions(allAuto(), { controlnet: { mode: 'fixed', value: {} } });

    const { permissions, disabled } = effectivePermissions(job, {
      capabilities: {
        unavailable: [{ feature: 'controlnet', reason: 'ControlNet 拡張が入っていない' }],
      },
      hasMask: true,
    });

    expect(permissions.controlnet).toEqual({ mode: 'off' });
    expect(disabled.controlnet).toEqual({
      kind: 'backend',
      detail: 'ControlNet 拡張が入っていない',
    });
  });

  it('takes inpaint out of the choices while there is no mask, so the loop never waits for one', () => {
    const { permissions, disabled } = effectivePermissions(allAuto(), {
      capabilities: { unavailable: [] },
      hasMask: false,
    });

    expect(permissions.inpaint).toEqual({ mode: 'off' });
    expect(disabled.inpaint).toEqual({ kind: 'no-mask' });
    expect(permissions.img2img).toEqual({ mode: 'auto' });
  });

  it('offers inpaint again once a mask exists', () => {
    const { permissions } = effectivePermissions(allAuto(), {
      capabilities: { unavailable: [] },
      hasMask: true,
    });

    expect(permissions.inpaint).toEqual({ mode: 'auto' });
  });
});

describe('effectivePermissions when inpaint is missing for two reasons', () => {
  it('shows the backend reason rather than the missing mask', () => {
    const { disabled } = effectivePermissions(allAuto(), {
      capabilities: { unavailable: [{ feature: 'inpaint', reason: 'inpaint に対応していない' }] },
      hasMask: false,
    });

    expect(disabled.inpaint).toEqual({ kind: 'backend', detail: 'inpaint に対応していない' });
  });
});

describe('permissionSchema', () => {
  it('reads the three forms a permission can take in a settings file', () => {
    expect(permissionSchema.parse({ mode: 'auto', choices: ['animeMix'] })).toEqual({
      mode: 'auto',
      choices: ['animeMix'],
    });
    expect(permissionSchema.parse({ mode: 'fixed', value: 28 })).toEqual({
      mode: 'fixed',
      value: 28,
    });
    expect(permissionSchema.parse({ mode: 'off' })).toEqual({ mode: 'off' });
  });

  it('rejects a mode it does not know', () => {
    expect(permissionSchema.safeParse({ mode: 'ask-human' }).success).toBe(false);
  });
});

describe('permissions for the fields a generation cannot do without', () => {
  it.each(REQUIRED_PARAM_KEYS)('does not let %s be turned off', (key) => {
    expect(permissionsSchema.safeParse({ ...allAuto(), [key]: { mode: 'off' } }).success).toBe(
      false,
    );
    expect(permissionOverridesSchema.safeParse({ [key]: { mode: 'off' } }).success).toBe(false);
  });

  it.each(REQUIRED_PARAM_KEYS)('lets %s be left to the AI or fixed', (key) => {
    expect(permissionOverridesSchema.safeParse({ [key]: { mode: 'auto' } }).success).toBe(true);
    expect(
      permissionOverridesSchema.safeParse({ [key]: { mode: 'fixed', value: FIXED_SAMPLES[key] } })
        .success,
    ).toBe(true);
  });

  it('still lets the other parameters be turned off', () => {
    expect(
      permissionsSchema.safeParse({ ...allAuto(), vae: { mode: 'off' }, hiresFix: { mode: 'off' } })
        .success,
    ).toBe(true);
  });

  it('covers exactly the request fields the backend has no default for', () => {
    const withoutDefault = PARAM_KEYS.filter(
      (key) =>
        Object.hasOwn(generationRequestSchema.shape, key) &&
        !generationRequestSchema.shape[key as keyof typeof generationRequestSchema.shape].safeParse(
          undefined,
        ).success,
    );
    expect([...withoutDefault].sort()).toEqual([...REQUIRED_PARAM_KEYS].sort());
  });

  it('rejects an override for a parameter it does not know', () => {
    expect(permissionOverridesSchema.safeParse({ denoise: { mode: 'off' } }).success).toBe(false);
  });
});

describe('the shape of the permissions', () => {
  it('refuses the global permissions when any one field is missing', () => {
    for (const key of PARAM_KEYS) {
      const missing: Partial<Permissions> = allAuto();
      delete missing[key];
      expect(permissionsSchema.safeParse(missing).success, key).toBe(false);
    }
  });

  it('accepts overrides that leave a non-required field to the AI or turn it off', () => {
    for (const key of PARAM_KEYS.filter(
      (k) => !(REQUIRED_PARAM_KEYS as readonly ParamKey[]).includes(k),
    )) {
      for (const mode of ['auto', 'off'] as const) {
        expect(
          permissionOverridesSchema.safeParse({ [key]: { mode } }).success,
          `${key} ${mode}`,
        ).toBe(true);
      }
    }
  });
});

describe('fixed values', () => {
  it.each(PARAM_KEYS)('takes a fixed %s in the shape the generation request uses', (key) => {
    expect(
      permissionOverridesSchema.safeParse({ [key]: { mode: 'fixed', value: FIXED_SAMPLES[key] } })
        .success,
    ).toBe(true);
  });

  it.each([
    ['steps', 'twenty'],
    ['steps', 0],
    ['cfgScale', '7'],
    ['checkpoint', ''],
    ['loras', [{ weight: 1 }]],
    ['hiresFix', { scale: 2 }],
  ] as const)('refuses a fixed %s of %j and names the field that is wrong', (key, value) => {
    const result = permissionOverridesSchema.safeParse({ [key]: { mode: 'fixed', value } });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path.slice(0, 2)).toEqual([key, 'value']);
  });

  it('refuses a fixed permission without a value', () => {
    expect(permissionOverridesSchema.safeParse({ vae: { mode: 'fixed' } }).success).toBe(false);
  });

  it('checks the fixed values of the global permissions too', () => {
    expect(
      permissionsSchema.safeParse({ ...allAuto(), width: { mode: 'fixed', value: 'wide' } })
        .success,
    ).toBe(false);
  });
});

describe('readPermissionOverrides', () => {
  it('keeps the rows it can read and says why each of the others is left out', () => {
    const { overrides, invalid } = readPermissionOverrides({
      steps: { mode: 'fixed', value: 28 },
      cfgScale: { mode: 'fixed', value: 'seven' },
      prompt: { mode: 'off' },
      denoise: { mode: 'auto' },
    });

    expect(overrides).toEqual({ steps: { mode: 'fixed', value: 28 } });
    expect(invalid.map(({ param }) => param)).toEqual(['cfgScale', 'prompt', 'denoise']);
    expect(invalid[0]?.reason).toContain('value');
    expect(invalid[2]?.reason).toBe('知らないパラメータ');
  });

  // 理由は画面（設定の許可）と drawroid doctor に出る。zod の英語のままだと、人が何を直せばよいか分からない
  it('says in short Japanese what to fix in each row it leaves out', () => {
    const { invalid } = readPermissionOverrides({
      cfgScale: { mode: 'fixed', value: 'seven' },
      prompt: { mode: 'off' },
      loras: { mode: 'sometimes' },
      steps: 'auto',
      width: { mode: 'fixed', value: -1 },
    });

    expect(invalid).toEqual([
      { param: 'cfgScale', reason: 'value: 形が違う（数で書く）' },
      // 欄の名前は道の側にだけ出す。「mode: mode は」と二度書かない
      { param: 'prompt', reason: 'mode: auto・fixed のどれかで書く（この欄は off にできない）' },
      { param: 'loras', reason: 'mode: auto・fixed・off のどれかで書く' },
      { param: 'steps', reason: '形が違う（オブジェクトで書く）' },
      // 幅の下限は 0 を含まない。「0 以上」と書くと、0 なら通るように読める
      { param: 'width', reason: 'value: 小さすぎる（0 より大きく）' },
    ]);
  });

  // 欄の中の欄の誤りは、道を全部書かないとどこを直すか分からない。1行に誤りが2つあれば、2つとも書く
  it('names the whole path of each problem in a row, and every problem of the row', () => {
    const { invalid } = readPermissionOverrides({
      loras: { mode: 'auto', choices: ['', 'a', ''] },
    });

    expect(invalid).toHaveLength(1);
    const where = invalid[0]?.reason.split(' / ').map((problem) => problem.split(': ')[0]);
    expect(where).toEqual(['choices.0', 'choices.2']);
  });

  it('never gives an English sentence from the validator as the reason', () => {
    const rows: Record<string, unknown>[] = [
      { steps: {} },
      { steps: { mode: 'x' } },
      { steps: 'auto' },
      { steps: null },
      { steps: { mode: 'fixed' } },
      { steps: { mode: 'fixed', value: 'many' } },
      { loras: { mode: 'auto', choices: 'a' } },
      { loras: { mode: 'auto', choices: [''] } },
      { width: { mode: 'fixed', value: -1 } },
      { hiresFix: { mode: 'fixed', value: { scale: 1 } } },
    ];
    for (const row of rows) {
      const { invalid } = readPermissionOverrides(row);
      expect(invalid, JSON.stringify(row)).toHaveLength(1);
      expect(invalid[0]?.reason, JSON.stringify(row)).not.toMatch(
        /Invalid|Unrecognized|Expected|expected|received|Too (small|big)|Required|must/,
      );
    }
  });

  it('reads nothing written as no overrides', () => {
    expect(readPermissionOverrides(undefined)).toEqual({ overrides: {}, invalid: [] });
  });

  it('leaves the whole out when it is not a set of rows, and says so', () => {
    const { overrides, invalid } = readPermissionOverrides(['steps']);

    expect(overrides).toEqual({});
    expect(invalid).toEqual([
      { param: '*', reason: '許可が、パラメータごとの欄の集まりになっていない' },
    ]);
  });
});

// 境目を含まない上限を持つ欄が今の許可のスキーマに無いので、範囲の文は合成したスキーマで縛る
describe('describePermissionIssue for a number out of range', () => {
  const reasonFor = (schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);
    const issue = result.error?.issues[0];
    if (issue === undefined) throw new Error(`${JSON.stringify(value)} が通ってしまった`);
    return describePermissionIssue(issue);
  };

  // 境目を含まない範囲を「以上」「以下」と書くと、境目の値なら通るように読める
  it('says whether the upper bound itself is allowed', () => {
    expect(reasonFor(z.number().lt(10), 10)).toBe('大きすぎる（10 より小さく）');
    expect(reasonFor(z.number().max(10), 11)).toBe('大きすぎる（10 以下）');
  });

  it('says whether the lower bound itself is allowed', () => {
    expect(reasonFor(z.number().gt(0), 0)).toBe('小さすぎる（0 より大きく）');
    expect(reasonFor(z.number().min(0), -1)).toBe('小さすぎる（0 以上）');
  });
});
