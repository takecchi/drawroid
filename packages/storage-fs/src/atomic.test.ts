import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failures = vi.hoisted(() => ({
  writeFile: false,
  sync: false,
  unlink: false,
}));

// 一時ファイルを書くために開いた handle と unlink だけを、失敗させられるように包む。子プロセスの試験には効かない
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (args[1] !== 'wx') return handle;
      const writeFile = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      handle.writeFile = (async (...a: Parameters<typeof writeFile>) => {
        if (failures.writeFile) throw new Error('writeFile failed');
        return writeFile(...a);
      }) as typeof handle.writeFile;
      handle.sync = async () => {
        if (failures.sync) throw new Error('sync failed');
        return sync();
      };
      return handle;
    },
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      if (failures.unlink) throw new Error('unlink failed');
      return real.unlink(...args);
    },
  };
});

import {
  createFileExclusive,
  createJsonExclusive,
  writeFileAtomic,
  writeJsonAtomic,
} from './atomic.js';

let dir: string;

beforeEach(async () => {
  failures.writeFile = false;
  failures.sync = false;
  failures.unlink = false;
  dir = await mkdtemp(join(tmpdir(), 'drawroid-atomic-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('writes indented JSON with a trailing newline', async () => {
    const path = join(dir, 'a.json');
    await writeJsonAtomic(path, { a: 1 });
    expect(await readFile(path, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });

  it('replaces an existing file and leaves no temp files behind', async () => {
    const path = join(dir, 'a.json');
    await writeJsonAtomic(path, { v: 1 });
    await writeJsonAtomic(path, { v: 2 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ v: 2 });
    expect(await readdir(dir)).toEqual(['a.json']);
  });
});

describe('writeFileAtomic', () => {
  it('fails without leaving a temp file when the directory does not exist', async () => {
    await expect(writeFileAtomic(join(dir, 'missing', 'a.json'), 'x')).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe.each([
  ['writeFileAtomic', writeFileAtomic],
  ['createFileExclusive', createFileExclusive],
])('%s when writing the temp file fails', (_name, write) => {
  it.each([
    ['writeFile', 'writeFile failed'],
    ['sync', 'sync failed'],
  ] as const)(
    'rejects with the original failure and leaves no temp file when %s fails',
    async (step, message) => {
      failures[step] = true;

      await expect(write(join(dir, 'a.json'), 'x')).rejects.toThrow(message);

      expect(await readdir(dir)).toEqual([]);
    },
  );

  it('still rejects with the original failure when the temp file cannot be removed either', async () => {
    failures.writeFile = true;
    failures.unlink = true;

    await expect(write(join(dir, 'a.json'), 'x')).rejects.toThrow('writeFile failed');
  });
});

describe('a process killed while writing', () => {
  const child = fileURLToPath(new URL('./test-fixtures/atomic-writer-child.mjs', import.meta.url));

  function killWhileWriting(target: string, delayMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [child, target], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      proc.stdout.once('data', () => setTimeout(() => proc.kill('SIGKILL'), delayMs));
      proc.once('exit', (_code, signal) =>
        signal === 'SIGKILL' ? resolve() : reject(new Error(`child exited early: ${stderr}`)),
      );
    });
  }

  it('never leaves a broken JSON file', async () => {
    const target = join(dir, 'state.json');
    for (const delayMs of [0, 1, 2, 3, 5, 7, 11, 15, 20, 30, 45, 60]) {
      await killWhileWriting(target, delayMs);
      const parsed = JSON.parse(await readFile(target, 'utf8')) as { payload: string };
      expect(parsed.payload).toHaveLength(256 * 1024);
    }
  }, 30_000);
});

describe('createJsonExclusive', () => {
  it('places a file only when the name is free, leaving the first one as it was', async () => {
    const path = join(dir, '000001.json');

    expect(await createJsonExclusive(path, { n: 1 })).toBe(true);
    expect(await createJsonExclusive(path, { n: 2 })).toBe(false);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ n: 1 });
    expect(await readdir(dir)).toEqual(['000001.json']);
  });

  it('writes indented JSON with a trailing newline, like the other writes', async () => {
    const path = join(dir, '000001.json');
    await createJsonExclusive(path, { a: 1 });
    expect(await readFile(path, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });
});
