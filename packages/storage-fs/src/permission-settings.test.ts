import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPermissionSettings } from './permission-settings.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-permission-settings-'));
  path = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readPermissionSettings', () => {
  it('has nothing when config.json does not exist', async () => {
    expect(await readPermissionSettings(path)).toBeUndefined();
  });

  it('has nothing when config.json has no permissions key', async () => {
    await writeFile(path, JSON.stringify({ backend: { kind: 'forge' } }));
    expect(await readPermissionSettings(path)).toBeUndefined();
  });

  it('reads the permissions key as it was written', async () => {
    await writeFile(path, JSON.stringify({ permissions: { steps: { mode: 'off' } } }));
    expect(await readPermissionSettings(path)).toEqual({ steps: { mode: 'off' } });
  });
});
