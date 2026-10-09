import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBackendSettings, writeBackendSettings } from './backend-settings.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-backend-settings-'));
  configPath = join(dir, 'config.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('backend settings in config.json', () => {
  it('reads nothing when the file or the key does not exist', async () => {
    expect(await readBackendSettings(configPath)).toBeUndefined();
    await writeFile(configPath, JSON.stringify({ llm: { a: 1 } }));
    expect(await readBackendSettings(configPath)).toBeUndefined();
  });

  it('writes the backend key even when config.json does not exist yet', async () => {
    await writeBackendSettings(configPath, { url: 'http://gpu:7860' });
    expect(await readBackendSettings(configPath)).toEqual({ url: 'http://gpu:7860' });
  });

  it('keeps the other keys when it rewrites the backend key', async () => {
    await writeFile(configPath, JSON.stringify({ llm: { model: 'x' }, backend: { url: 'a' } }));
    await writeBackendSettings(configPath, { url: 'http://gpu:7860' });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      llm: { model: 'x' },
      backend: { url: 'http://gpu:7860' },
    });
  });

  it('names the file when config.json is not a JSON object', async () => {
    await writeFile(configPath, '[]');
    await expect(readBackendSettings(configPath)).rejects.toThrow(/config\.json/);
    await expect(writeBackendSettings(configPath, {})).rejects.toThrow(/config\.json/);
  });
});
