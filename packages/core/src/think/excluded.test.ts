import { describe, expect, it } from 'vitest';

import { PARAM_KEYS } from '../params/param-key.js';
import { basicPermissions } from '../loop/iteration-permissions.js';
import type { Permissions } from '../permissions/permission.js';
import { excludedOf, iterationPlanSchema } from './excluded.js';

function allow(override: Partial<Permissions>): Permissions {
  return { ...basicPermissions({ width: 512, height: 512 }), ...override };
}

describe('excludedOf', () => {
  it('lists the excluded params in the order of PARAM_KEYS, whichever way they were given', () => {
    const merged = allow({ controlnet: { mode: 'auto' }, loras: { mode: 'auto' } });

    const excluded = excludedOf(
      merged,
      { controlnet: { kind: 'backend', detail: 'x' } },
      { loras: 'no-candidates-shown' },
    );

    expect(excluded.map((e) => e.param)).toEqual(
      PARAM_KEYS.filter((key) => key === 'loras' || key === 'controlnet'),
    );
  });

  it('does not list what the human turned off', () => {
    const merged = allow({ controlnet: { mode: 'off' }, inpaint: { mode: 'off' } });

    const excluded = excludedOf(
      merged,
      { controlnet: { kind: 'backend', detail: 'x' }, inpaint: { kind: 'no-mask' } },
      {},
    );

    expect(excluded).toEqual([]);
  });

  it('keeps that the human wanted it fixed when it was disabled', () => {
    const merged = allow({ vae: { mode: 'fixed', value: 'v' } });

    expect(excludedOf(merged, { vae: { kind: 'backend', detail: 'no vae' } }, {})).toEqual([
      { param: 'vae', wanted: 'fixed', reason: { kind: 'backend', detail: 'no vae' } },
    ]);
  });

  it('carries the reason a param was omitted from the schema, as left to the AI', () => {
    const merged = allow({ loras: { mode: 'auto' }, hiresFix: { mode: 'auto' } });

    expect(
      excludedOf(merged, {}, { loras: 'no-candidates-shown', hiresFix: 'no-candidates-shown' }),
    ).toEqual([
      { param: 'loras', wanted: 'auto', reason: { kind: 'no-candidates-shown' } },
      { param: 'hiresFix', wanted: 'auto', reason: { kind: 'no-candidates-shown' } },
    ]);
  });

  it('prefers the disabled reason when a param appears in both', () => {
    const merged = allow({ loras: { mode: 'auto' } });

    expect(
      excludedOf(merged, { loras: { kind: 'no-mask' } }, { loras: 'no-candidates-shown' }),
    ).toEqual([{ param: 'loras', wanted: 'auto', reason: { kind: 'no-mask' } }]);
  });

  it('lists nothing when everything reached the AI', () => {
    expect(excludedOf(allow({}), {}, {})).toEqual([]);
  });

  it('produces what iterationPlanSchema reads back', () => {
    const excluded = excludedOf(
      allow({ loras: { mode: 'auto' }, controlnet: { mode: 'fixed', value: 1 } }),
      { controlnet: { kind: 'backend', detail: 'x' } },
      { loras: 'no-candidates-shown' },
    );

    expect(iterationPlanSchema.parse({ excluded })).toEqual({ excluded });
  });

  it('does not read back a reason that nothing writes', () => {
    const plan = {
      excluded: [{ param: 'controlnet', wanted: 'auto', reason: { kind: 'not-supported-yet' } }],
    };

    expect(iterationPlanSchema.safeParse(plan).success).toBe(false);
  });
});
