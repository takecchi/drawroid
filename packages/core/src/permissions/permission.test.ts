import { describe, expect, it } from 'vitest';

import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import {
  effectivePermissions,
  mergePermissions,
  permissionSchema,
  type Permissions,
} from './permission.js';

const allAuto = (): Permissions =>
  Object.fromEntries(PARAM_KEYS.map((key) => [key, { mode: 'auto' }])) as Record<
    ParamKey,
    { mode: 'auto' }
  >;
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
