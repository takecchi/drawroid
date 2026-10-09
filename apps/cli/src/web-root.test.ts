import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pickWebRoot } from './web-root.js';

describe('pickWebRoot', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drawroid-web-root-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the web directory next to the entry file when it holds an index.html', async () => {
    const bundled = join(dir, 'web');
    await mkdir(bundled);
    await writeFile(join(bundled, 'index.html'), '<html></html>');

    expect(pickWebRoot(bundled, () => '/workspace/web/build/client')).toBe(bundled);
  });

  it('falls back to the workspace web build when the adjacent directory is missing', () => {
    expect(pickWebRoot(join(dir, 'web'), () => '/workspace/web/build/client')).toBe(
      '/workspace/web/build/client',
    );
  });

  it('falls back to the workspace web build when the adjacent directory has no index.html', async () => {
    const bundled = join(dir, 'web');
    await mkdir(bundled);

    expect(pickWebRoot(bundled, () => '/workspace/web/build/client')).toBe(
      '/workspace/web/build/client',
    );
  });

  it('does not resolve the workspace web build when the adjacent directory is usable', async () => {
    const bundled = join(dir, 'web');
    await mkdir(bundled);
    await writeFile(join(bundled, 'index.html'), '');

    expect(
      pickWebRoot(bundled, () => {
        throw new Error('@drawroid/web is not installed');
      }),
    ).toBe(bundled);
  });
});
