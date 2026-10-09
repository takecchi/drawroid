import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfigObject } from './config-file.js';
import {
  readGenerationProgressSettings,
  writeGenerationProgressSettings,
} from './generation-progress-settings.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-generation-progress-'));
  configPath = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('generation progress settings in config.json', () => {
  it('reads nothing when the file or the key does not exist', async () => {
    expect(await readGenerationProgressSettings(configPath)).toBeUndefined();

    await writeFile(configPath, JSON.stringify({ backend: { type: 'forge' } }));
    expect(await readGenerationProgressSettings(configPath)).toBeUndefined();
  });

  it('reads back what was written', async () => {
    await writeGenerationProgressSettings(configPath, { includePreview: true });

    expect(await readGenerationProgressSettings(configPath)).toEqual({ includePreview: true });
  });

  it('keeps the other keys when writing', async () => {
    const others = {
      llm: { roles: { think: { model: 'm' } } },
      budgets: { imageLongEdge: 256 },
      permissions: { steps: { mode: 'auto' } },
    };
    await writeFile(configPath, JSON.stringify(others));

    await writeGenerationProgressSettings(configPath, { includePreview: true });

    expect(await readConfigObject(configPath)).toEqual({
      ...others,
      generationProgress: { includePreview: true },
    });
  });
});
