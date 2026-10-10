import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDataDir } from '@drawroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { describeStartupFailure } from './startup-failure.js';

const failure = (code: string, path?: string) =>
  Object.assign(new Error(`${code}: permission denied, mkdir '${path}'`), { code, path });

describe('describeStartupFailure', () => {
  it('names the port when it is taken', () => {
    expect(describeStartupFailure(failure('EADDRINUSE'))).toBe(
      'drawroid: ポートが既に使われている。--port で別のポートを指定する',
    );
  });

  it.each([
    [
      'EACCES',
      'データディレクトリを読み書きできなかった（EACCES）',
      '--data-dir で書ける場所を指して',
    ],
    [
      'EPERM',
      'データディレクトリを読み書きできなかった（EPERM）',
      '--data-dir で書ける場所を指して',
    ],
    [
      'EROFS',
      'データディレクトリが読み取り専用で、書けなかった（EROFS）',
      '--data-dir で書ける場所を指して',
    ],
    [
      'ENOSPC',
      'ディスクの空きが足りず、データディレクトリに書けなかった（ENOSPC）',
      '空きを作ってから起動し直す',
    ],
  ])('says what went wrong on %s, where, and what to do, in one line', (code, said, next) => {
    const text = describeStartupFailure(failure(code, '/srv/drawroid/jobs'));

    expect(text.startsWith(`drawroid: ${said}: /srv/drawroid/jobs。`)).toBe(true);
    expect(text).toContain(next);
    expect(text).not.toContain('permission denied');
    expect(text).not.toContain('\n');
  });

  it('keeps the message of a failure it cannot tell apart', () => {
    expect(describeStartupFailure(new Error('config.json の形が違う'))).toBe(
      'drawroid: config.json の形が違う',
    );
  });

  // 本物の失敗の形で確かめる: 手で作った失敗では、code や path の持ち方がずれても気づけないため
  it.skipIf(process.getuid?.() === 0)(
    'tells a data directory that cannot be made, from the real failure',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'drawroid-startup-'));
      try {
        await chmod(parent, 0o500);
        const error = await initDataDir(join(parent, 'home')).catch((caught: unknown) => caught);

        expect(describeStartupFailure(error)).toMatch(
          new RegExp(
            `^drawroid: データディレクトリを読み書きできなかった（EACCES）: ${parent}/home。`,
          ),
        );
      } finally {
        await chmod(parent, 0o700);
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
