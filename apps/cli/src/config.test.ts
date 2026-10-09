import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKEND_KIND,
  DEFAULT_BACKEND_URL,
  readConfig,
  resolveBackendKind,
  resolveBackendUrl,
} from './config.js';

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
      kind: 'a1111',
      url: 'http://gpu:7860',
      auth: { username: 'u', password: 'p' },
      generateTimeoutMs: 120000,
    };
    await writeFile(path, JSON.stringify({ backend }));
    expect(await readConfig(path)).toEqual({ backend });
  });

  it('reads the old forgeUrl as the url', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ backend: { forgeUrl: 'http://gpu:7860' } }));
    expect(await readConfig(path)).toEqual({ backend: { url: 'http://gpu:7860' } });
  });

  it('refuses a config.json with both url and the old forgeUrl', async () => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ backend: { url: 'http://a:7860', forgeUrl: 'http://b:7860' } }),
    );
    await expect(readConfig(path)).rejects.toThrow(/config\.json.*url と forgeUrl/s);
  });

  it('names the file when it is not JSON', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, '{ broken');
    await expect(readConfig(path)).rejects.toThrow(/config\.json/);
  });

  it('names the file when a value has the wrong shape', async () => {
    const path = join(dir, 'config.json');
    for (const bad of [
      { backend: { url: 'not a url' } },
      { backend: { forgeUrl: 'not a url' } },
      { backend: { generateTimeoutMs: 0 } },
      { backend: { kind: 'comfyui' } },
    ]) {
      await writeFile(path, JSON.stringify(bad));
      await expect(readConfig(path)).rejects.toThrow(/config\.json/);
    }
  });
});

describe('resolveBackendUrl', () => {
  it('prefers the CLI argument, then config.json, then the default', () => {
    const config = { backend: { url: 'http://from-config:7860' } };
    expect(resolveBackendUrl('http://from-arg:7860', config)).toBe('http://from-arg:7860');
    expect(resolveBackendUrl(undefined, config)).toBe('http://from-config:7860');
    expect(resolveBackendUrl(undefined, {})).toBe(DEFAULT_BACKEND_URL);
  });
});

describe('resolveBackendKind', () => {
  it('prefers the CLI argument, then config.json, then Forge', () => {
    const config = { backend: { kind: 'a1111' as const } };
    expect(resolveBackendKind('forge', config)).toBe('forge');
    expect(resolveBackendKind(undefined, config)).toBe('a1111');
    expect(resolveBackendKind(undefined, {})).toBe(DEFAULT_BACKEND_KIND);
    expect(DEFAULT_BACKEND_KIND).toBe('forge');
  });
});
