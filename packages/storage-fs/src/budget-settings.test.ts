import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBudgetSettings, writeBudgetSettings } from './budget-settings.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-budget-settings-'));
  configPath = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('budget settings in config.json', () => {
  it('reads nothing when the file does not exist or has no budgets key', async () => {
    expect(await readBudgetSettings(configPath)).toBeUndefined();

    await writeFile(configPath, JSON.stringify({ backend: { type: 'forge' } }));
    expect(await readBudgetSettings(configPath)).toBeUndefined();
  });

  it('reads back what was written', async () => {
    await writeBudgetSettings(configPath, { imageLongEdge: 256 });

    expect(await readBudgetSettings(configPath)).toEqual({ imageLongEdge: 256 });
  });

  it('keeps the llm, backend and permissions keys when replacing budgets', async () => {
    const others = {
      llm: { roles: { think: { model: 'm' } } },
      backend: { type: 'forge', url: 'http://127.0.0.1:7860' },
      permissions: { steps: { mode: 'auto' } },
    };
    await writeFile(configPath, JSON.stringify({ ...others, budgets: { imageLongEdge: 256 } }));

    await writeBudgetSettings(configPath, { imagesPerJudge: 2 });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      ...others,
      budgets: { imagesPerJudge: 2 },
    });
  });
});
