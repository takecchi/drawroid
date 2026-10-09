import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_BUDGETS } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBudgetSettings } from './budget-settings.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-cli-budget-'));
  configPath = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('budget settings of the CLI', () => {
  it('resolves to the defaults when config.json has no budgets', async () => {
    const { overrides, effective } = await createBudgetSettings(configPath).read();

    expect(overrides).toEqual({});
    expect(effective).toEqual(DEFAULT_BUDGETS);
  });

  it('overlays what was written onto the defaults and reads it back', async () => {
    const settings = createBudgetSettings(configPath);

    const written = await settings.write({ imageLongEdge: 256 });
    const read = await settings.read();

    expect(written.imageLongEdge).toBe(256);
    expect(read.overrides).toEqual({ imageLongEdge: 256 });
    expect(read.effective).toEqual({ ...DEFAULT_BUDGETS, imageLongEdge: 256 });
  });

  it('throws the reason when budgets in config.json are invalid', async () => {
    await writeFile(configPath, JSON.stringify({ budgets: { imageLongEdge: 0 } }));

    await expect(createBudgetSettings(configPath).read()).rejects.toThrow(/imageLongEdge/);
  });
});
