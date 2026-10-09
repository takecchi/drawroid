import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGenerationProgressSettings } from './generation-progress-settings.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-cli-progress-'));
  configPath = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('generation progress settings of the CLI', () => {
  it('is disabled when config.json has no generationProgress', async () => {
    expect(await createGenerationProgressSettings(configPath).read()).toEqual({
      includePreview: false,
    });
  });

  it('reads back what was written', async () => {
    const settings = createGenerationProgressSettings(configPath);
    await settings.write({ includePreview: true });

    expect(await settings.read()).toEqual({ includePreview: true });
  });

  it('refuses to read an invalid setting rather than falling back to the default', async () => {
    await writeFile(configPath, JSON.stringify({ generationProgress: { includePreview: 'yes' } }));

    await expect(createGenerationProgressSettings(configPath).read()).rejects.toThrow(
      /generationProgress/,
    );
  });
});
