import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FORGE_URL, readConfig, resolveForgeUrl } from './config.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('returns an empty config when config.json does not exist', async () => {
    expect(await readConfig(join(dir, 'config.json'))).toEqual({});
  });

  it('reads the backend settings', async () => {
    const path = join(dir, 'config.json');
    const backend = {
      forgeUrl: 'http://gpu:7860',
      auth: { username: 'u', password: 'p' },
      generateTimeoutMs: 120000,
    };
    await writeFile(path, JSON.stringify({ backend }));
    expect(await readConfig(path)).toEqual({ backend });
  });

  it('names the file when it is not JSON', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, '{ broken');
    await expect(readConfig(path)).rejects.toThrow(/config\.json/);
  });

  it('names the file when a value has the wrong shape', async () => {
    const path = join(dir, 'config.json');
    for (const bad of [
      { backend: { forgeUrl: 'not a url' } },
      { backend: { generateTimeoutMs: 0 } },
    ]) {
      await writeFile(path, JSON.stringify(bad));
      await expect(readConfig(path)).rejects.toThrow(/config\.json/);
    }
  });
});

describe('resolveForgeUrl', () => {
  it('prefers the CLI argument, then config.json, then the default', () => {
    const config = { backend: { forgeUrl: 'http://from-config:7860' } };
    expect(resolveForgeUrl('http://from-arg:7860', config)).toBe('http://from-arg:7860');
    expect(resolveForgeUrl(undefined, config)).toBe('http://from-config:7860');
    expect(resolveForgeUrl(undefined, {})).toBe(DEFAULT_FORGE_URL);
  });
});
