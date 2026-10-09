import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  type LlmCallRecord,
  type NewJobSpec,
} from '@drawroid/core';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatJobId,
  FsJobStore,
  ImageAlreadySentError,
  isJobId,
  StoredFileError,
} from './job-store.js';
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
const queuedAuto: JobState = {
  status: 'queued',
  carry: { intent: '夕暮れの海辺の少女', completedIterations: 0 },
};

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

  it('keeps the carry of an auto job in its state, while a manual job has none', async () => {
    const jobs = store();
    const manual = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const auto = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:31:00Z'));
    const carry = {
      intent: '夕暮れの海辺の少女',
      completedIterations: 1,
      latest: {
        iteration: 1,
        imageIndex: 0,
        score: 0.6,
        params: { prompt: 'girl, sunset' },
        issues: ['背景が暗い'],
        nextChange: 'もっと逆光にする',
      },
    };
    await jobs.writeState(auto.jobId, {
      status: 'running',
      carry,
      startedAt: '2026-10-09T06:31:00.000Z',
      imagesGenerated: 2,
    });
    expect(await jobs.readState(auto.jobId)).toMatchObject({ status: 'running', carry });
    expect(await jobs.readState(manual.jobId)).toEqual({ status: 'queued' });
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

describe('FsJobStore interventions', () => {
  it('lists interventions in the order they were received, from the files alone', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await jobs.addIntervention(
      a.jobId,
      { kind: 'stopConditions', stopConditions: { maxIterations: 3 } },
      new Date('2026-10-09T06:31:00Z'),
    );
    await jobs.addIntervention(
      a.jobId,
      { kind: 'instruction', text: '逆光にして' },
      new Date('2026-10-09T06:32:00Z'),
    );

    const listed = await jobs.listInterventions(a.jobId);
    expect(listed).toEqual([
      expect.objectContaining({ kind: 'stopConditions', stopConditions: { maxIterations: 3 } }),
      expect.objectContaining({ kind: 'instruction', text: '逆光にして' }),
    ]);
    expect(listed[1]).not.toHaveProperty('appliedInIteration');
    expect(await readdir(dataPaths(root).jobFiles(a.jobId).interventions)).toHaveLength(2);
  });

  it('has no interventions for a job nobody has spoken to', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    expect(await jobs.listInterventions(a.jobId)).toEqual([]);
  });

  it('refuses a stop condition change that changes nothing', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await expect(
      jobs.addIntervention(
        a.jobId,
        { kind: 'stopConditions', stopConditions: {} },
        new Date('2026-10-09T06:31:00Z'),
      ),
    ).rejects.toThrow();
  });

  it('refuses an empty instruction', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await expect(
      jobs.addIntervention(a.jobId, { kind: 'instruction', text: '' }, new Date()),
    ).rejects.toThrow();
  });

  it('writes back which think took an instruction in, keeping its original text', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const said = await jobs.addIntervention(
      a.jobId,
      { kind: 'instruction', text: '逆光にして' },
      new Date('2026-10-09T06:31:00Z'),
    );
    await jobs.markInterventionApplied(a.jobId, said.interventionId, 4);
    expect(await jobs.listInterventions(a.jobId)).toEqual([{ ...said, appliedInIteration: 4 }]);
  });

  it('refuses to mark a stop condition change as taken into a think', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const change = await jobs.addIntervention(
      a.jobId,
      { kind: 'stopConditions', stopConditions: { maxIterations: 3 } },
      new Date('2026-10-09T06:31:00Z'),
    );
    await expect(jobs.markInterventionApplied(a.jobId, change.interventionId, 1)).rejects.toThrow(
      StoredFileError,
    );
  });

  it('refuses a job or intervention id that could point outside the data directory', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const said = { kind: 'instruction' as const, text: '逆光にして' };
    await expect(jobs.addIntervention('../../x', said, new Date())).rejects.toThrow();
    await expect(jobs.listInterventions('../../x')).rejects.toThrow();
    await expect(jobs.markInterventionApplied(a.jobId, '../../state', 1)).rejects.toThrow();
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

async function putImage(
  jobId: string,
  iteration: number,
  index: number,
  width: number,
  height: number,
) {
  const path = dataPaths(root).jobFiles(jobId).iteration(iteration).image(index);
  await mkdir(join(path, '..'), { recursive: true });
  const png = await sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  await writeFile(path, png);
}

function record(callId: string, jobId: string | null): LlmCallRecord {
  return {
    callId,
    jobId,
    iteration: jobId === null ? null : 1,
    role: 'think',
    purpose: 'think',
    provider: 'local',
    model: 'qwen',
    startedAt: '2026-10-09T00:00:00.000Z',
    durationMs: 10,
    input: { system: 's', user: [] },
    budget: { estimatedInputTokens: 1, inputTokenLimit: 2, notes: [] },
    attempts: [],
    usage: { inputTokens: null, outputTokens: null },
    outcome: { ok: false, reason: 'x' },
  };
}

describe('FsJobStore stages', () => {
  it('tells a stage that has not run yet by the missing file', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    expect(await jobs.readStage(a.jobId, 1, 'think')).toBeUndefined();
    await jobs.writeStage(a.jobId, 1, 'think', { params: { prompt: 'girl' }, rationale: 'r' });
    expect(await jobs.readStage(a.jobId, 1, 'think')).toEqual({
      params: { prompt: 'girl' },
      rationale: 'r',
    });
    expect(await jobs.readStage(a.jobId, 1, 'judge')).toBeUndefined();
    expect(await readdir(dataPaths(root).jobFiles(a.jobId).iterations)).toEqual(['0001']);
  });
});

describe('FsJobStore previews', () => {
  it('makes a webp preview whose long edge is within the limit, and keeps it next to the original', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 1216, 832);
    const preview = await jobs.loadPreview({ jobId: a.jobId, iteration: 1, index: 0 }, 512);

    expect(preview).toMatchObject({
      key: `jobs/${a.jobId}/iterations/0001/images/0`,
      mediaType: 'image/webp',
      longEdge: 512,
    });
    expect(preview.sentInCall).toBeUndefined();
    const meta = await sharp(preview.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 512, 350]);
    await stat(dataPaths(root).jobFiles(a.jobId).iteration(1).preview(0, 512));
  });

  it('reuses the preview it already made', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 1024, 1024);
    const ref = { jobId: a.jobId, iteration: 1, index: 0 };
    await jobs.loadPreview(ref, 512);
    const path = dataPaths(root).jobFiles(a.jobId).iteration(1).preview(0, 512);
    const before = (await stat(path)).mtimeMs;
    await jobs.loadPreview(ref, 512);
    expect((await stat(path)).mtimeMs).toBe(before);
  });

  it('does not enlarge a small image', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 300, 200);
    const preview = await jobs.loadPreview({ jobId: a.jobId, iteration: 1, index: 0 }, 512);
    expect(preview.longEdge).toBe(300);
  });

  it('keeps previews of different sizes apart', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 1024, 768);
    const ref = { jobId: a.jobId, iteration: 1, index: 0 };
    expect((await jobs.loadPreview(ref, 512)).longEdge).toBe(512);
    expect((await jobs.loadPreview(ref, 384)).longEdge).toBe(384);
  });
});

describe('FsJobStore sent marks', () => {
  it('reports the call that already received the image', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 640, 640);
    const ref = { jobId: a.jobId, iteration: 1, index: 0 };
    await jobs.markSent(ref, 'call-1', new Date('2026-10-09T06:31:00Z'));
    expect((await jobs.loadPreview(ref, 512)).sentInCall).toBe('call-1');
  });

  it('refuses to mark the same image twice, keeping the first mark', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 640, 640);
    const ref = { jobId: a.jobId, iteration: 1, index: 0 };
    await jobs.markSent(ref, 'call-1', new Date('2026-10-09T06:31:00Z'));
    await expect(jobs.markSent(ref, 'call-2', new Date('2026-10-09T06:32:00Z'))).rejects.toThrow(
      ImageAlreadySentError,
    );
    expect((await jobs.loadPreview(ref, 512)).sentInCall).toBe('call-1');
  });
});

describe('FsJobStore iterations', () => {
  it('lists iteration numbers in numeric order, past the tenth', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    expect(await jobs.listIterations(a.jobId)).toEqual([]);
    for (const iteration of [10, 2, 1, 11]) {
      await jobs.writeStage(a.jobId, iteration, 'think', {});
    }
    const iterations = dataPaths(root).jobFiles(a.jobId).iterations;
    await writeFile(join(iterations, `${TEMP_FILE_PREFIX}9`), '');
    await writeFile(join(iterations, 'notes'), '');

    expect(await jobs.listIterations(a.jobId)).toEqual([1, 2, 10, 11]);
  });
});

describe('FsJobStore LLM call records', () => {
  it('puts job calls under the job and other calls at the top level, listing them in order', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    await jobs.writeLlmCall(record('0002', a.jobId));
    await jobs.writeLlmCall(record('0001', a.jobId));
    await jobs.writeLlmCall(record('0001-parse', null));

    expect((await jobs.listLlmCalls(a.jobId)).map((r) => r.callId)).toEqual(['0001', '0002']);
    expect((await jobs.listLlmCalls(null)).map((r) => r.callId)).toEqual(['0001-parse']);
    await stat(join(root, 'jobs', a.jobId, 'llm-calls', '0001.json'));
    await stat(join(root, 'llm-calls', '0001-parse.json'));
  });

  it('lists readable records and reports the broken ones with a reason', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    await jobs.writeLlmCall(record('0001', a.jobId));
    const dir = dataPaths(root).jobFiles(a.jobId).llmCalls;
    await writeFile(join(dir, '0002.json'), '{ not json');
    await writeFile(join(dir, '0003.json'), JSON.stringify({ callId: '0003' }));
    await jobs.writeLlmCall(record('0004', a.jobId));
    // 合計に使う欄はそろっているが、一覧が読む outcome が無い
    await writeFile(
      join(dir, '0005.json'),
      JSON.stringify({ ...record('0005', a.jobId), outcome: undefined }),
    );

    const { records, invalid } = await jobs.listLlmCallRecords(a.jobId);

    expect(records.map((r) => r.callId)).toEqual(['0001', '0004']);
    expect(invalid.map((i) => i.callId)).toEqual(['0002', '0003', '0005']);
    expect(invalid.every((i) => i.reason.length > 0)).toBe(true);
  });

  it('returns no records for a job that has made no call', async () => {
    const jobs = store();
    const a = await jobs.createJob(autoSpec, queuedAuto, new Date('2026-10-09T06:30:00Z'));
    expect(await jobs.listLlmCalls(a.jobId)).toEqual([]);
  });
});

describe('FsJobStore selections', () => {
  const favorite = {
    imageKey: '2-1',
    verdict: 'favorite' as const,
    selectedAt: '2026-10-09T06:31:00.000Z',
  };

  it('keeps one selection per image under selections/, overwriting a reselection', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    expect(await jobs.readSelection(a.jobId, '2-1')).toBeUndefined();

    await jobs.writeSelection(a.jobId, favorite);
    const changed = { ...favorite, verdict: null, previous: 'favorite' as const };
    await jobs.writeSelection(a.jobId, changed);

    expect(await jobs.readSelection(a.jobId, '2-1')).toEqual(changed);
    expect(await jobs.listSelections(a.jobId)).toEqual([changed]);
    expect(await readdir(dataPaths(root).jobFiles(a.jobId).selections)).toEqual(['2-1.json']);
  });

  it('refuses an image key that could point outside the job', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await expect(jobs.readSelection(a.jobId, '../../job')).rejects.toThrow();
    await expect(
      jobs.writeSelection(a.jobId, { ...favorite, imageKey: '../state' }),
    ).rejects.toThrow();
  });
});

describe('FsJobStore references', () => {
  async function reference(width: number, height: number): Promise<Uint8Array> {
    return sharp({ create: { width, height, channels: 3, background: '#2266aa' } })
      .png()
      .toBuffer();
  }

  it('keeps references under refs/ in the order they arrived', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const first = await jobs.addReference(
      a.jobId,
      { data: await reference(64, 64), mediaType: 'image/png', note: 'この構図で' },
      new Date('2026-10-09T06:31:00Z'),
    );
    const second = await jobs.addReference(
      a.jobId,
      { data: await reference(64, 64), mediaType: 'image/png' },
      new Date('2026-10-09T06:32:00Z'),
    );

    expect(await jobs.listReferences(a.jobId)).toEqual([first, second]);
    expect(await readdir(dataPaths(root).jobFiles(a.jobId).refs)).toEqual(
      expect.arrayContaining([`${first.refId}.png`, `${first.refId}.json`]),
    );
  });

  it('shrinks a reference for the LLM and refuses to mark it sent twice', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const ref = await jobs.addReference(
      a.jobId,
      { data: await reference(1600, 900), mediaType: 'image/png' },
      new Date('2026-10-09T06:31:00Z'),
    );
    const image = { jobId: a.jobId, refId: ref.refId };

    const preview = await jobs.loadPreview(image, 512);
    expect(preview.longEdge).toBe(512);
    expect(preview.sentInCall).toBeUndefined();

    await jobs.markSent(image, 'c1', new Date('2026-10-09T06:32:00Z'));
    expect((await jobs.loadPreview(image, 512)).sentInCall).toBe('c1');
    await expect(jobs.markSent(image, 'c2', new Date())).rejects.toThrow(ImageAlreadySentError);
  });

  it('keeps the gist next to the reference', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    const ref = await jobs.addReference(
      a.jobId,
      { data: await reference(64, 64), mediaType: 'image/png' },
      new Date('2026-10-09T06:31:00Z'),
    );
    await jobs.writeReferenceGist(a.jobId, ref.refId, '青い背景');
    expect(await jobs.listReferences(a.jobId)).toEqual([{ ...ref, gist: '青い背景' }]);
  });

  it('refuses a reference or intervention id that could point outside the job', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await expect(jobs.writeReferenceGist(a.jobId, '../../config', 'x')).rejects.toThrow();
    await expect(jobs.loadPreview({ jobId: a.jobId, refId: '../x' }, 512)).rejects.toThrow();
    await expect(jobs.markInterventionApplied(a.jobId, '../../state', 1)).rejects.toThrow();
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
