import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeBackendSettings } from './backend-settings.js';
import { readConfigObject, updateConfigObject } from './config-file.js';
import { writeLlmSettings } from './llm-settings.js';
import { writePermissionSettings } from './permission-settings.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-config-file-'));
  path = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readConfig = async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

describe('reading config.json that is not JSON', () => {
  it('fails with the message of JSON.parse kept as the original, so the caller can say it in its own words', async () => {
    await writeFile(path, '{');
    let original = '';
    try {
      JSON.parse('{');
    } catch (error) {
      original = (error as Error).message;
    }

    await expect(readConfigObject(path)).rejects.toMatchObject({ original });
  });

  it('keeps failing with a plain error for JSON that is not an object', async () => {
    await writeFile(path, '[1]');

    const error = await readConfigObject(path).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('original');
  });
});

describe('writing config.json from several places at once', () => {
  it('keeps both changes when the LLM settings and the permissions are written at the same time', async () => {
    const llm = { providers: {} };
    const permissions = { steps: { mode: 'fixed', value: 28 } };

    await Promise.all([writeLlmSettings(path, llm), writePermissionSettings(path, permissions)]);

    expect(await readConfig()).toEqual({ llm, permissions });
  });

  it('keeps both changes when the permissions and the backend settings are written at the same time', async () => {
    const permissions = { steps: { mode: 'fixed', value: 28 } };
    const backend = { kind: 'forge', url: 'http://127.0.0.1:7860' };

    await Promise.all([
      writePermissionSettings(path, permissions),
      writeBackendSettings(path, backend),
    ]);

    expect(await readConfig()).toEqual({ permissions, backend });
  });

  it('keeps both changes when the backend settings and the LLM settings are written at the same time', async () => {
    const backend = { kind: 'a1111', url: 'http://127.0.0.1:7861' };
    const llm = { providers: {} };

    await Promise.all([writeBackendSettings(path, backend), writeLlmSettings(path, llm)]);

    expect(await readConfig()).toEqual({ backend, llm });
  });

  it('keeps every change when many updates of the same file come at once', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        updateConfigObject(path, (current) => ({ ...current, [`key${n}`]: n })),
      ),
    );

    expect(Object.keys(await readConfig())).toHaveLength(20);
  });

  it('goes on with later updates after one of them fails', async () => {
    const failing = updateConfigObject(path, () => {
      throw new Error('変えられない');
    });
    const later = updateConfigObject(path, (current) => ({ ...current, after: true }));

    await expect(failing).rejects.toThrow('変えられない');
    await later;
    expect(await readConfig()).toEqual({ after: true });
  });
});
