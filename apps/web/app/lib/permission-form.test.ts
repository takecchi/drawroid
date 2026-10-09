import { describe, expect, it } from 'vitest';

import { buildOverrides, describePermission, toRows, type Rows } from './permission-form';

describe('toRows', () => {
  it('leaves what was not written as the default, and shows written values as they are', () => {
    const rows = toRows({
      steps: { mode: 'fixed', value: 28 },
      checkpoint: { mode: 'auto', choices: ['a.safetensors'] },
      hiresFix: { mode: 'fixed', value: { upscaler: 'Latent', scale: 2 } },
      vae: { mode: 'off' },
    });

    expect(rows.prompt).toEqual({ mode: 'default', choices: undefined, fixedText: '' });
    expect(rows.steps).toEqual({ mode: 'fixed', choices: undefined, fixedText: '28' });
    expect(rows.checkpoint).toEqual({
      mode: 'auto',
      choices: ['a.safetensors'],
      fixedText: '',
    });
    expect(rows.hiresFix.fixedText).toBe('{"upscaler":"Latent","scale":2}');
    expect(rows.vae.mode).toBe('off');
  });
});

describe('buildOverrides', () => {
  const edit = (change: Partial<Rows>): Rows => ({ ...toRows({}), ...change });

  it('writes only the rows that are not left as the default', () => {
    const result = buildOverrides(
      edit({
        steps: { mode: 'fixed', choices: undefined, fixedText: ' 28 ' },
        negativePrompt: { mode: 'fixed', choices: undefined, fixedText: 'lowres' },
        loras: { mode: 'auto', choices: ['detail', 'style'], fixedText: '' },
        sampler: { mode: 'auto', choices: undefined, fixedText: '' },
        vae: { mode: 'off', choices: undefined, fixedText: '' },
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        steps: { mode: 'fixed', value: 28 },
        negativePrompt: { mode: 'fixed', value: 'lowres' },
        loras: { mode: 'auto', choices: ['detail', 'style'] },
        sampler: { mode: 'auto' },
        vae: { mode: 'off' },
      },
    });
  });

  it('reads a fixed value given as JSON for the parameters that take a structure', () => {
    const result = buildOverrides(
      edit({
        hiresFix: {
          mode: 'fixed',
          choices: undefined,
          fixedText: '{"upscaler":"Latent","scale":2,"steps":0,"denoisingStrength":0.5}',
        },
      }),
    );

    expect(result.ok && result.value.hiresFix).toEqual({
      mode: 'fixed',
      value: { upscaler: 'Latent', scale: 2, steps: 0, denoisingStrength: 0.5 },
    });
  });

  it.each([
    ['steps', '二十', 'steps'],
    ['steps', '0', 'steps'],
    ['cfgScale', '', 'CFG scale'],
    ['loras', '[{', 'LoRA'],
    ['checkpoint', '', 'checkpoint'],
  ] as const)('refuses a fixed %s of %j and says which parameter it was', (key, text, label) => {
    const result = buildOverrides(
      edit({ [key]: { mode: 'fixed', choices: undefined, fixedText: text } }),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(label);
  });

  it('refuses to turn off a parameter that every generation needs', () => {
    const result = buildOverrides(
      edit({ prompt: { mode: 'off', choices: undefined, fixedText: '' } }),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'プロンプト: 生成に欠かせないので「使わない」は選べない',
    });
  });

  it('refuses to let the AI choose from no candidates at all', () => {
    const result = buildOverrides(
      edit({ checkpoint: { mode: 'auto', choices: [], fixedText: '' } }),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('checkpoint');
  });
});

describe('describePermission', () => {
  it('says in words what the permission in effect does', () => {
    expect(describePermission({ mode: 'auto' })).toBe('AI に任せる');
    expect(describePermission({ mode: 'auto', choices: ['a', 'b'] })).toBe(
      'AI に任せる（候補を 2 個に絞る）',
    );
    expect(describePermission({ mode: 'fixed', value: 512 })).toBe('固定: 512');
    expect(describePermission({ mode: 'fixed', value: { scale: 2 } })).toBe('固定: {"scale":2}');
    expect(describePermission({ mode: 'off' })).toBe('使わない');
  });
});
