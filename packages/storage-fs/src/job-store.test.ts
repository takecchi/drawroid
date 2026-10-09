import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobState, LlmCallRecord } from '@drawroid/core';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatJobId, FsJobStore, ImageAlreadySentError, StoredFileError } from './job-store.js';
import { dataPaths } from './paths.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-jobs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const spec = {
  kind: 'auto' as const,
  request: '夕暮れの海辺の少女',
  stopConditions: { aiJudgement: true, maxIterations: 10 },
  batchSize: 2,
};
const queued: JobState = {
  status: 'queued',
  carry: { intent: '夕暮れの海辺の少女', completedIterations: 0 },
};

function store(suffixes: string[] = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd']) {
  let i = 0;
  return new FsJobStore(root, { randomSuffix: () => suffixes[i++ % suffixes.length] ?? 'zzzzzz' });
}

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

describe('formatJobId', () => {
  it('puts the UTC creation time first so that name order is creation order', () => {
    expect(formatJobId(new Date('2026-10-09T06:30:12.345Z'), 'k3f9a1')).toBe(
      '20261009-063012-k3f9a1',
    );
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
});

describe('FsJobStore interventions', () => {
  it('lists interventions in the order they were received, from the files alone', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await jobs.addIntervention(
      a.jobId,
      { stopConditions: { maxIterations: 3 } },
      new Date('2026-10-09T06:31:00Z'),
    );
    await jobs.addIntervention(
      a.jobId,
      { stopConditions: { maxIterations: null } },
      new Date('2026-10-09T06:32:00Z'),
    );

    const listed = await jobs.listInterventions(a.jobId);
    expect(listed.map((i) => i.stopConditions)).toEqual([
      { maxIterations: 3 },
      { maxIterations: null },
    ]);
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
      jobs.addIntervention(a.jobId, { stopConditions: {} }, new Date('2026-10-09T06:31:00Z')),
    ).rejects.toThrow();
  });
});

describe('FsJobStore stages', () => {
  it('tells a stage that has not run yet by the missing file', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
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
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
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
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
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
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 300, 200);
    const preview = await jobs.loadPreview({ jobId: a.jobId, iteration: 1, index: 0 }, 512);
    expect(preview.longEdge).toBe(300);
  });

  it('keeps previews of different sizes apart', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 1024, 768);
    const ref = { jobId: a.jobId, iteration: 1, index: 0 };
    expect((await jobs.loadPreview(ref, 512)).longEdge).toBe(512);
    expect((await jobs.loadPreview(ref, 384)).longEdge).toBe(384);
  });
});

describe('FsJobStore sent marks', () => {
  it('reports the call that already received the image', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 640, 640);
    const ref = { jobId: a.jobId, iteration: 1, index: 0 };
    await jobs.markSent(ref, 'call-1', new Date('2026-10-09T06:31:00Z'));
    expect((await jobs.loadPreview(ref, 512)).sentInCall).toBe('call-1');
  });

  it('refuses to mark the same image twice, keeping the first mark', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await putImage(a.jobId, 1, 0, 640, 640);
    const ref = { jobId: a.jobId, iteration: 1, index: 0 };
    await jobs.markSent(ref, 'call-1', new Date('2026-10-09T06:31:00Z'));
    await expect(jobs.markSent(ref, 'call-2', new Date('2026-10-09T06:32:00Z'))).rejects.toThrow(
      ImageAlreadySentError,
    );
    expect((await jobs.loadPreview(ref, 512)).sentInCall).toBe('call-1');
  });
});

describe('FsJobStore LLM call records', () => {
  it('puts job calls under the job and other calls at the top level, listing them in order', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    await jobs.writeLlmCall(record('0002', a.jobId));
    await jobs.writeLlmCall(record('0001', a.jobId));
    await jobs.writeLlmCall(record('0001-parse', null));

    expect((await jobs.listLlmCalls(a.jobId)).map((r) => r.callId)).toEqual(['0001', '0002']);
    expect((await jobs.listLlmCalls(null)).map((r) => r.callId)).toEqual(['0001-parse']);
    await stat(join(root, 'jobs', a.jobId, 'llm-calls', '0001.json'));
    await stat(join(root, 'llm-calls', '0001-parse.json'));
  });

  it('returns no records for a job that has made no call', async () => {
    const jobs = store();
    const a = await jobs.createJob(spec, queued, new Date('2026-10-09T06:30:00Z'));
    expect(await jobs.listLlmCalls(a.jobId)).toEqual([]);
  });
});
