import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi, type ApiDeps } from '@drawroid/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGenerationProgressSettings } from './generation-progress-settings.js';
import { stubDeps } from './test-support.js';

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

  it('says which field is broken in Japanese, with the original message after it', async () => {
    await writeFile(configPath, JSON.stringify({ generationProgress: { includePreview: 'yes' } }));

    await expect(createGenerationProgressSettings(configPath).read()).rejects.toThrow(
      new Error(
        'config.json の generationProgress.includePreview が読めない（true か false で書く）（原文: Invalid input: expected boolean, received string）',
      ),
    );
  });

  it('gives the same sentence through the settings API and the progress preview API as invalid_config', async () => {
    await writeFile(configPath, JSON.stringify({ generationProgress: { includePreview: 'yes' } }));
    const app = createApi({
      ...stubDeps(dir),
      store: { listJobIds: async () => ['job1'] } as unknown as ApiDeps['store'],
      generationProgressSettings: createGenerationProgressSettings(configPath),
    });
    const message =
      'config.json の generationProgress.includePreview が読めない（true か false で書く）（原文: Invalid input: expected boolean, received string）';

    for (const path of ['/settings/generation-progress', '/jobs/job1/progress-preview']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(500);
      expect(await res.json(), path).toEqual({ error: { kind: 'invalid_config', message } });
    }
  });

  it('names generationProgress itself when the whole setting is not an object', async () => {
    await writeFile(configPath, JSON.stringify({ generationProgress: 7 }));

    await expect(createGenerationProgressSettings(configPath).read()).rejects.toThrow(
      new Error(
        'config.json の generationProgress が読めない（{ … } の形で書く）（原文: Invalid input: expected object, received number）',
      ),
    );
  });
});
