import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generationRequestSchema,
  jobSpecSchema,
  jobStateSchema,
  type GenerationRequest,
  type GenerationResult,
  type JobState,
  type NewJobSpec,
} from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatJobId, FsJobStore, isJobId, StoredFileError } from './job-store.js';
import { dataPaths, TEMP_FILE_PREFIX } from './paths.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-jobs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request: GenerationRequest = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
  batchSize: 2,
});
const spec: NewJobSpec = { kind: 'manual', request };
const autoSpec: NewJobSpec = {
  kind: 'auto',
  request: '夕暮れの海辺の少女',
  stopConditions: { aiJudgement: true, maxIterations: 10 },
  batchSize: 2,
};
const queued: JobState = { status: 'queued' };

function store(suffixes: string[] = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd']) {
  let i = 0;
  return new FsJobStore(root, { randomSuffix: () => suffixes[i++ % suffixes.length] ?? 'zzzzzz' });
}

function result(seeds: (number | null)[]): GenerationResult {
  return {
    images: seeds.map((seed, i) => ({
      png: Uint8Array.of(137, 80, 78, 71, i),
      seed,
      metadata: { index: i },
    })),
    metadata: { stub: true },
  };
}

describe('formatJobId', () => {
  it('puts the UTC creation time first so that name order is creation order', () => {
    expect(formatJobId(new Date('2026-10-09T06:30:12.345Z'), 'k3f9a1')).toBe(
      '20261009-063012-k3f9a1',
    );
  });
});

describe('isJobId', () => {
  it('accepts an id that formatJobId made and refuses anything that could leave the jobs directory', () => {
    expect(isJobId(formatJobId(new Date('2026-10-09T06:30:12Z'), 'k3f9a1'))).toBe(true);
    for (const bad of ['', '..', '../x', '20261009-063012-a/b', 'config.json']) {
      expect(isJobId(bad), bad).toBe(false);
    }
  });
});

describe('FsJobStore jobs', () => {
  it('creates job.json and state.json that can be read back', async () => {
    const jobs = store();
    const created = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:12Z'));
    expect(created).toMatchObject({ ...spec, jobId: '20261009-063012-aaaaaa' });
    expect(await jobs.readJob(created.jobId)).toEqual(created);
    expect(await jobs.readState(created.jobId)).toEqual(queued);
  });

  it('keeps both kinds of job spec apart by kind', async () => {
    const jobs = store();
    const manual = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const auto = await jobs.createJob(autoSpec, queued, new Date('2026-10-09T06:31:00Z'));
    expect(await jobs.readJob(manual.jobId)).toMatchObject({ kind: 'manual', request });
    expect(await jobs.readJob(auto.jobId)).toMatchObject({ kind: 'auto', batchSize: 2 });
  });

  it('lists jobs in creation order from the directories alone', async () => {
    const jobs = store();
    const b = await jobs.createJob(spec, queued, new Date('2026-10-09T06:31:00Z'));
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    expect(await jobs.listJobIds()).toEqual([a.jobId, b.jobId]);
  });

  it('forgets a job when its directory is deleted', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const b = await jobs.createJob(spec, queued, new Date('2026-10-09T06:31:00Z'));
    await rm(dataPaths(root).job(a.jobId), { recursive: true });
    expect(await jobs.listJobIds()).toEqual([b.jobId]);
  });

  it('does not list a directory that has no job.json yet, nor temporary files', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await mkdir(dataPaths(root).job('20261009-070000-halfway'));
    await writeFile(join(dataPaths(root).jobs, '.tmp-123-x'), '');
    expect(await jobs.listJobIds()).toEqual([a.jobId]);
  });

  it('picks another id when the same id already exists', async () => {
    const jobs = store(['same00', 'same00', 'other0']);
    const now = new Date('2026-10-09T06:30:00Z');
    const first = await jobs.createJob(spec, queued, now);
    const second = await jobs.createJob(spec, queued, now);
    expect(second.jobId).not.toBe(first.jobId);
  });

  it('refuses to read a state.json that a human broke, naming the file', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await writeFile(dataPaths(root).jobFiles(a.jobId).state, '{"status":"flying"}');
    await expect(jobs.readState(a.jobId)).rejects.toThrow(StoredFileError);
    await expect(jobs.readState(a.jobId)).rejects.toThrow(/state\.json/);
  });

  it('refuses to write a state that does not match the schema', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await expect(
      jobs.writeState(a.jobId, { status: 'running' } as unknown as JobState),
    ).rejects.toThrow();
    expect(await jobs.readState(a.jobId)).toEqual(queued);
  });

  it('keeps the kind of the backend error in a stopped state', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const stopped: JobState = {
      status: 'stopped',
      stoppedAt: '2026-10-09T06:31:00.000Z',
      imagesGenerated: 0,
      reason: { kind: 'error', detail: '繋がらない', backendErrorKind: 'unreachable' },
    };
    await jobs.writeState(a.jobId, stopped);
    expect(await jobs.readState(a.jobId)).toEqual(stopped);
  });
});

describe('FsJobStore generations', () => {
  it('lists a saved generation with its request and seeds, and reads the images back', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const generated = result([5, 6]);
    await jobs.writeGeneration(a.jobId, 1, request, generated);

    expect(await jobs.listGenerations(a.jobId)).toEqual([
      {
        iteration: 1,
        request,
        images: [
          { index: 0, seed: 5 },
          { index: 1, seed: 6 },
        ],
      },
    ]);
    const ref = { jobId: a.jobId, iteration: 1 };
    expect(new Uint8Array((await jobs.readImage({ ...ref, index: 1 })) ?? [])).toEqual(
      generated.images[1]?.png,
    );
  });

  it('keeps the backend metadata next to each image', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await jobs.writeGeneration(a.jobId, 1, request, result([null]));
    const meta = JSON.parse(
      await readFile(dataPaths(root).jobFiles(a.jobId).iteration(1).imageMeta(0), 'utf8'),
    ) as unknown;
    expect(meta).toEqual({ seed: null, metadata: { index: 0 }, response: { stub: true } });
  });

  it('does not list an iteration whose request.json has not been written', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await jobs.writeGeneration(a.jobId, 1, request, result([1]));
    const files = dataPaths(root).jobFiles(a.jobId).iteration(2);
    await mkdir(files.images, { recursive: true });
    await writeFile(files.image(0), 'half');
    expect((await jobs.listGenerations(a.jobId)).map((g) => g.iteration)).toEqual([1]);
  });

  it('lists iterations in numeric order even past four digits', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    for (const iteration of [10000, 2, 1]) {
      await jobs.writeGeneration(a.jobId, iteration, request, result([iteration]));
    }
    expect((await jobs.listGenerations(a.jobId)).map((g) => g.iteration)).toEqual([1, 2, 10000]);
  });

  it('returns no generations for a job that has none, and undefined for a missing image', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    expect(await jobs.listGenerations(a.jobId)).toEqual([]);
    expect(await jobs.readImage({ jobId: a.jobId, iteration: 1, index: 0 })).toBeUndefined();
  });
});

describe('a process killed while saving a job', () => {
  const child = fileURLToPath(
    new URL('./test-fixtures/job-store-writer-child.mjs', import.meta.url),
  );

  function killWhileSaving(dir: string, delayMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [child, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      proc.stdout.once('data', () => setTimeout(() => proc.kill('SIGKILL'), delayMs));
      proc.once('exit', (_code, signal) =>
        signal === 'SIGKILL' ? resolve() : reject(new Error(`child exited early: ${stderr}`)),
      );
    });
  }

  const schemas = {
    'job.json': jobSpecSchema,
    'state.json': jobStateSchema,
    'request.json': generationRequestSchema,
  } as const;

  it('never leaves a JSON file that is broken or does not match its schema', async () => {
    for (const delayMs of [0, 1, 2, 3, 5, 7, 11, 15, 20, 30, 45, 60, 90]) {
      const dir = join(root, `kill-${delayMs}`);
      await killWhileSaving(dir, delayMs);
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        // 殺された書き込みが残す一時ファイルは、読み手が無視し、起動時に片付けるもの
        if (entry.name.startsWith(TEMP_FILE_PREFIX)) continue;
        const path = join(entry.parentPath, entry.name);
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
        const schema = schemas[basename(path) as keyof typeof schemas];
        if (schema !== undefined) expect(schema.safeParse(parsed).success, path).toBe(true);
      }

      // 一覧に出るジョブは、読めて、保存の済んだ回の画像が揃っている
      const jobs = new FsJobStore(dir);
      for (const jobId of await jobs.listJobIds()) {
        await jobs.readJob(jobId);
        await jobs.readState(jobId);
        for (const generation of await jobs.listGenerations(jobId)) {
          expect(generation.images).toHaveLength(2);
          for (const image of generation.images) {
            const png = await jobs.readImage({
              jobId,
              iteration: generation.iteration,
              index: image.index,
            });
            expect(png).toHaveLength(128 * 1024);
          }
        }
      }
    }
  }, 60_000);
});
