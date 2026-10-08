import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileAtomic, writeJsonAtomic } from './atomic.js';

let dir: string;

beforeEach(async () => {
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
