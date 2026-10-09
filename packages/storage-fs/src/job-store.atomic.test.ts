import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { generationRequestSchema, type GenerationResult } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsJobStore } from './job-store.js';
import { dataPaths, TEMP_FILE_PREFIX } from './paths.js';

type Call = { op: 'open' | 'writeFile' | 'rename'; path: string; to?: string; flags?: unknown };
const calls: Call[] = [];

// ファイルの口を差し替えて呼ばれ方を記録する: 途中で殺して残ったものを見る試験は、殺す瞬間しだいで当たり外れが出るため
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (path: string, flags?: unknown, mode?: unknown) => {
      calls.push({ op: 'open', path: String(path), flags });
      return actual.open(path, flags as string, mode as number);
    }) as typeof actual.open,
    writeFile: (async (path: unknown, ...rest: unknown[]) => {
      calls.push({ op: 'writeFile', path: String(path) });
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
    }) as typeof actual.writeFile,
    rename: (async (from: string, to: string) => {
      calls.push({ op: 'rename', path: String(from), to: String(to) });
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-atomic-'));
  calls.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
  batchSize: 2,
});

const result: GenerationResult = {
  images: [0, 1].map((i) => ({ png: Uint8Array.of(137, 80, 78, 71, i), seed: i, metadata: {} })),
  metadata: {},
};

describe('writing a generation', () => {
  it('puts every image in place by renaming a temporary file in the same directory, never writing the image path directly', async () => {
    const store = new FsJobStore(root);
    const { jobId } = await store.createJob(
      { kind: 'manual', request },
      { status: 'queued' },
      new Date(),
    );
    await store.writeGeneration(jobId, 1, request, result);

    const iteration = dataPaths(root).jobFiles(jobId).iteration(1);
    for (const index of [0, 1]) {
      const image = iteration.image(index);
      expect(calls.filter((c) => c.op !== 'rename' && c.path === image)).toEqual([]);
      const renames = calls.filter((c) => c.op === 'rename' && c.to === image);
      expect(renames).toHaveLength(1);
      const from = renames[0]!.path;
      expect(dirname(from)).toBe(dirname(image));
      expect(basename(from).startsWith(TEMP_FILE_PREFIX)).toBe(true);
    }
  });
});
