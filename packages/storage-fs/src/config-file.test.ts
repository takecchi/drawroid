import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { updateConfigObject } from './config-file.js';
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

describe('writing config.json from several places at once', () => {
  it('keeps both changes when the LLM settings and the permissions are written at the same time', async () => {
    const llm = { providers: {} };
    const permissions = { steps: { mode: 'fixed', value: 28 } };

    await Promise.all([writeLlmSettings(path, llm), writePermissionSettings(path, permissions)]);

    expect(await readConfig()).toEqual({ llm, permissions });
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
