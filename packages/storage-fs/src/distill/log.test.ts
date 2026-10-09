import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MODEL_WINDOW,
  type DistillEntry,
  distillStoppedJob,
  type LlmCall,
  type LlmCallOutcome,
  type LlmPort,
} from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFsMemoryStore } from '../memory/store.js';
import { dataPaths } from '../paths.js';
import { createFsDistillLog } from './log.js';

const JOB = '20261009-153012-k3f9';

let root: string;
let paths: ReturnType<typeof dataPaths>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-distill-'));
  paths = dataPaths(root);
  await mkdir(paths.job(JOB), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function entry(at: string): DistillEntry {
  return {
    kind: 'stopped',
    at,
    callId: null,
    shown: { interventions: [], selections: [], memory: [] },
    budgetNotes: [],
    applied: [],
    skipped: [],
  };
}

const distillFile = () => paths.jobFiles(JOB).distill;

describe('createFsDistillLog', () => {
  it('appends each distillation to distill.json in the job directory, keeping the earlier ones', async () => {
    const log = createFsDistillLog(root);

    await log.append(JOB, entry('2026-10-09T16:00:00Z'));
    await log.append(JOB, entry('2026-10-09T17:00:00Z'));

    expect((await log.read(JOB)).map((e) => e.at)).toEqual([
      '2026-10-09T16:00:00Z',
      '2026-10-09T17:00:00Z',
    ]);
    expect(JSON.parse(await readFile(distillFile(), 'utf8'))).toMatchObject({ jobId: JOB });
  });

  it('keeps every entry when distillations of the same job are appended at the same time', async () => {
    const log = createFsDistillLog(root);

    await Promise.all(
      Array.from({ length: 10 }, (_, n) => log.append(JOB, entry(`2026-10-09T16:00:0${n}Z`))),
    );

    expect(await log.read(JOB)).toHaveLength(10);
  });

  it('refuses to append to a distill.json it cannot read, leaving the file as it was', async () => {
    const log = createFsDistillLog(root);
    await writeFile(distillFile(), '{ "jobId": "hand-edited", ');

    await expect(log.append(JOB, entry('2026-10-09T16:00:00Z'))).rejects.toThrow();

    expect(await readFile(distillFile(), 'utf8')).toBe('{ "jobId": "hand-edited", ');
  });

  it('does not bring back a job directory the human deleted', async () => {
    const log = createFsDistillLog(root);
    await rm(paths.job(JOB), { recursive: true });

    await expect(log.append(JOB, entry('2026-10-09T16:00:00Z'))).rejects.toThrow();

    expect(await readdir(paths.jobs)).toEqual([]);
  });

  it('leaves only the finished distill.json in the job directory, with no temporary file', async () => {
    const log = createFsDistillLog(root);

    await log.append(JOB, entry('2026-10-09T16:00:00Z'));

    expect(await readdir(paths.job(JOB))).toEqual(['distill.json']);
  });

  it('reads an empty history for a job that has not been distilled', async () => {
    expect(await createFsDistillLog(root).read(JOB)).toEqual([]);
  });

  it('rejects a job id that points outside the jobs directory', async () => {
    const log = createFsDistillLog(root);

    await expect(log.append('../escape', entry('2026-10-09T16:00:00Z'))).rejects.toThrow();
  });
});

describe('createFsDistillLog with a distill.json it cannot read', () => {
  it('rejects both append and read, instead of treating a distill.json that is a directory as empty', async () => {
    const log = createFsDistillLog(root);
    await mkdir(distillFile());

    await expect(log.read(JOB)).rejects.toThrow();
    await expect(log.append(JOB, entry('2026-10-09T16:00:00Z'))).rejects.toThrow();
  });

  it('writes nothing into a real sibling directory that a path-like job id points at', async () => {
    const log = createFsDistillLog(root);
    const sibling = join(paths.jobs, '..', 'sibling');
    await mkdir(sibling);

    await expect(log.append('../sibling', entry('2026-10-09T16:00:00Z'))).rejects.toThrow();

    expect(await readdir(sibling)).toEqual([]);
  });
});

describe('distilling into the data directory', () => {
  it('writes the learned preference as a memory file that names the job, and the distillation into distill.json', async () => {
    const llm: LlmPort = {
      describe: (role) => ({
        provider: 'stub',
        model: `stub-${role}`,
        window: DEFAULT_MODEL_WINDOW,
        imageInput: true,
      }),
      async generateStructured<T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>> {
        const value = call.schema.parse({
          operations: [{ op: 'add', body: '指の崩れは許容しない', tags: [], scope: 'always' }],
        });
        return { ok: true, value, attempts: [] };
      },
      streamStep: () => {
        throw new Error('この試験では使わない');
      },
    };
    const memory = createFsMemoryStore(paths.memory);
    const log = createFsDistillLog(root);

    await distillStoppedJob(
      { llm, memory, log, window: DEFAULT_MODEL_WINDOW, newMemoryId: () => 'fingers' },
      {
        jobId: JOB,
        intent: '夕暮れの海辺に立つ少女',
        stopReason: { kind: 'human', detail: '人間が止めた' },
        interventions: [{ id: 'i1', text: '指の崩れは許容しない' }],
        selections: [],
      },
    );

    expect(await memory.get('fingers')).toMatchObject({ scope: 'always', sources: [JOB] });
    expect(await readFile(join(paths.memory, 'fingers.md'), 'utf8')).toContain(JOB);
    expect((await log.read(JOB))[0]).toMatchObject({
      kind: 'stopped',
      shown: { interventions: ['i1'] },
      applied: [{ op: 'add', id: 'fingers' }],
    });
  });
});
