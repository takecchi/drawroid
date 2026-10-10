// ジョブの画面は 1〜2 秒ごとに全回のファイルを読む。書き終わったファイルを要求のたびに読み直さないこと、
// そのうえで書き換わったファイル・書き換わりうるファイルを古いまま返さないことを見る
import * as fs from 'node:fs/promises';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generationRequestSchema,
  type AdoptedRecord,
  type GenerationResult,
  type JobState,
  type LlmCallRecord,
  type NewJobSpec,
} from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsJobStore, type FsJobStoreOptions } from './job-store.js';
import { dataPaths } from './paths.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-read-cache-'));
});
afterEach(async () => {
  vi.mocked(fs.readFile).mockClear();
  await rm(root, { recursive: true, force: true });
});

const autoSpec: NewJobSpec = {
  kind: 'auto',
  request: '夕暮れの海辺の少女',
  stopConditions: { aiJudgement: true, maxIterations: 10 },
  batchSize: 2,
};
const queuedAuto: JobState = {
  status: 'queued',
  carry: { intent: '夕暮れの海辺の少女', completedIterations: 0 },
};
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
  metadata: { stub: true },
};

function callRecord(callId: string, jobId: string, durationMs = 10): LlmCallRecord {
  return {
    callId,
    jobId,
    iteration: 1,
    role: 'think',
    purpose: 'think',
    provider: 'local',
    model: 'qwen',
    startedAt: '2026-10-09T00:00:00.000Z',
    durationMs,
    input: { system: 's', user: [] },
    budget: { estimatedInputTokens: 1, inputTokenLimit: 2, notes: [] },
    attempts: [],
    usage: { inputTokens: null, outputTokens: null },
    chars: { input: 1, output: 0 },
    outcome: { ok: false, reason: 'x' },
  };
}

/** 1回目は見る役が済み、2回目は人が選んで済んだジョブ */
async function finishedJob(options: FsJobStoreOptions = {}) {
  const store = new FsJobStore(root, { randomSuffix: () => 'aaaaaa', ...options });
  const { jobId } = await store.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
  for (const iteration of [1, 2]) {
    await store.writeStage(jobId, iteration, 'plan', { excluded: [] });
    await store.writeStage(jobId, iteration, 'think', { params: { prompt: 'girl' } });
    await store.writeGeneration(jobId, iteration, request, result);
  }
  await store.writeStage(jobId, 1, 'judge', { canStop: false, images: [{ score: 1 }] });
  const adopted: AdoptedRecord = {
    by: 'human',
    image: { iteration: 2, index: 0 },
    score: 1,
    interventionId: '000001',
    adoptedAt: '2026-10-09T06:31:00.000Z',
  };
  await store.writeAdopted(jobId, 2, adopted);
  await store.writeLlmCall(callRecord('0001', jobId));
  await store.writeLlmCall(callRecord('0002', jobId));
  return { store, jobId, files: dataPaths(root).jobFiles(jobId) };
}

async function readEverything(store: FsJobStore, jobId: string) {
  for (const iteration of [1, 2]) {
    await store.readStage(jobId, iteration, 'think');
    await store.readStage(jobId, iteration, 'plan');
    await store.readStage(jobId, iteration, 'judge');
    await store.readAdopted(jobId, iteration);
    await store.readGeneration(jobId, iteration);
  }
  await store.readState(jobId);
  await store.readJob(jobId);
  await store.listLlmCallRecords(jobId);
}

function readsOf(path: string): number {
  return vi.mocked(fs.readFile).mock.calls.filter(([p]) => p === path).length;
}

/** 大きさと更新時刻を変えずに、中身だけを差し替える（inode も変わらない） */
async function rewriteInPlaceKeepingStat(path: string, text: string) {
  const before = await stat(path);
  expect(Buffer.byteLength(text)).toBe(before.size);
  await writeFile(path, text);
  await utimes(path, before.atime, before.mtime);
}

describe('FsJobStore reading finished iteration files', () => {
  it('reads each written-once file from disk only once across repeated reads', async () => {
    const { store, jobId, files } = await finishedJob();
    await readEverything(store, jobId);
    vi.mocked(fs.readFile).mockClear();

    await readEverything(store, jobId);
    await readEverything(store, jobId);

    const once = [1, 2].flatMap((n) => {
      const it = files.iteration(n);
      return [it.think, it.request, it.imageMeta(0), it.imageMeta(1)];
    });
    once.push(files.iteration(1).judge, files.iteration(2).adopted);
    once.push(files.llmCall('0001'), files.llmCall('0002'));
    for (const path of once) expect(readsOf(path), path).toBe(0);
  });

  it('reads the files that are rewritten (plan, state, job) on every read', async () => {
    const { store, jobId, files } = await finishedJob();
    await readEverything(store, jobId);
    vi.mocked(fs.readFile).mockClear();

    await readEverything(store, jobId);

    for (const path of [files.iteration(1).plan, files.iteration(2).plan, files.state, files.spec])
      expect(readsOf(path), path).toBe(1);
  });

  // plan.json は、考える役を呼ぶ途中で落ちると再開で書き直される。大きさも時刻も同じ書き直しでも、古い中身を返さない
  it('returns the new plan even when it is rewritten with the same size and time', async () => {
    const { store, jobId, files } = await finishedJob();
    const path = files.iteration(1).plan;
    await store.readStage(jobId, 1, 'plan');
    await rewriteInPlaceKeepingStat(path, '{"excluded":["x"]}'.padEnd((await stat(path)).size));

    expect(await store.readStage(jobId, 1, 'plan')).toEqual({ excluded: ['x'] });
  });

  it('returns the new content of a file rewritten through the store, even at the same size and time', async () => {
    const { store, jobId, files } = await finishedJob();
    const path = files.iteration(1).judge;
    await store.readStage(jobId, 1, 'judge');
    const before = await stat(path);
    await store.writeStage(jobId, 1, 'judge', { canStop: false, images: [{ score: 2 }] });
    await utimes(path, before.atime, before.mtime);
    expect((await stat(path)).size).toBe(before.size);

    expect(await store.readStage(jobId, 1, 'judge')).toEqual({
      canStop: false,
      images: [{ score: 2 }],
    });
  });

  it('returns the new content of a file a human edited in place', async () => {
    const { store, jobId, files } = await finishedJob();
    const path = files.iteration(1).think;
    await store.readStage(jobId, 1, 'think');
    const size = (await stat(path)).size;
    await writeFile(path, '{"params":{"prompt":"boy"}}'.padEnd(size));
    await utimes(path, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));

    expect(await store.readStage(jobId, 1, 'think')).toEqual({ params: { prompt: 'boy' } });
  });

  it('returns the new content of an LLM call record a human edited', async () => {
    const { store, jobId, files } = await finishedJob();
    await store.listLlmCallRecords(jobId);
    await writeFile(files.llmCall('0002'), JSON.stringify(callRecord('0002', jobId, 99)));

    const { records } = await store.listLlmCallRecords(jobId);
    expect(records.map((r) => r.durationMs)).toEqual([10, 99]);
  });

  it('forgets a file that was deleted', async () => {
    const { store, jobId, files } = await finishedJob();
    await store.readStage(jobId, 1, 'judge');
    await rm(files.iteration(1).judge);

    expect(await store.readStage(jobId, 1, 'judge')).toBeUndefined();
  });

  it('keeps no more than the configured bytes, reading again what it let go', async () => {
    const { store, jobId, files } = await finishedJob();
    const think1 = files.iteration(1).think;
    const think2 = files.iteration(2).think;
    const small = new FsJobStore(root, { readCacheBytes: (await stat(think1)).size });

    await small.readStage(jobId, 1, 'think');
    await small.readStage(jobId, 2, 'think');
    await small.readStage(jobId, 1, 'think');
    await small.readStage(jobId, 1, 'think');

    // 1つ分しか持てない: 2回目を読んだ時点で1回目を手放し、その後の1回目は1度だけ読み直す
    expect(readsOf(think1)).toBe(2);
    expect(readsOf(think2)).toBe(1);
    // 既定の大きさなら、同じ順で読んでも1度ずつ
    vi.mocked(fs.readFile).mockClear();
    const roomy = store;
    for (const n of [1, 2, 1, 1]) await roomy.readStage(jobId, n, 'think');
    expect(readsOf(think1)).toBe(1);
    expect(readsOf(think2)).toBe(1);
  });
});
