import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initDataDir } from './init.js';

let root: string;

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'drawroid-init-')), 'data');
});

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('initDataDir', () => {
  it('creates the data directory and its top-level directories', async () => {
    await initDataDir(root);
    expect((await readdir(root)).sort()).toEqual(['jobs', 'llm-calls', 'memory']);
  });

  it('can run again without touching existing files', async () => {
    await initDataDir(root);
    await writeFile(join(root, 'config.json'), '{"kept":true}\n');
    await initDataDir(root);
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{"kept":true}\n');
  });

  it('sweeps temp files left by a crashed write, and only those', async () => {
    const { paths } = await initDataDir(root);
    await writeFile(join(paths.jobs, '.tmp-abc-state.json'), '{"half');
    await writeFile(join(paths.jobs, 'keep.json'), '{}');
    const { sweptTempFiles } = await initDataDir(root);
    expect(sweptTempFiles).toEqual([join(paths.jobs, '.tmp-abc-state.json')]);
    expect(await readdir(paths.jobs)).toEqual(['keep.json']);
  });
});
