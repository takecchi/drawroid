import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  jobSpecSchema,
  jobStateSchema,
  type ImageRef,
  type JobSpec,
  type JobState,
  type JobStore,
  type LlmCallRecord,
  type PreviewImage,
  type StageName,
} from '@drawroid/core';
import sharp from 'sharp';
import type { ZodType } from 'zod';

import { writeFileAtomic, writeJsonAtomic } from './atomic.js';
import { dataPaths, TEMP_FILE_PREFIX, type DataPaths } from './paths.js';

export class ImageAlreadySentError extends Error {
  constructor(key: string, callId: string) {
    super(`画像 ${key} は呼び出し ${callId} で LLM に渡し済み`);
    this.name = 'ImageAlreadySentError';
  }
}

export class StoredFileError extends Error {
  constructor(path: string, cause: unknown) {
    super(`${path} を読めない: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'StoredFileError';
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new StoredFileError(path, error);
  }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return await readJson(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readValid<T>(path: string, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(path));
  if (!parsed.success) throw new StoredFileError(path, parsed.error);
  return parsed.data;
}

/** 名前の順で並べた、一時ファイルでない項目の名前 */
async function listNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => !name.startsWith(TEMP_FILE_PREFIX)).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

// UTC で書く: 地方時だと夏時間の切り替えで、名前の順と作成の順が食い違うため
export function formatJobId(now: Date, suffix: string): string {
  const iso = now.toISOString(); // 2026-10-09T06:30:12.345Z
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}-${suffix}`;
}

export type FsJobStoreOptions = {
  /** jobId の末尾に付ける短い乱数（試験で差し替える） */
  randomSuffix?: () => string;
};

export class FsJobStore implements JobStore {
  private readonly paths: DataPaths;
  private readonly randomSuffix: () => string;

  constructor(root: string, options: FsJobStoreOptions = {}) {
    this.paths = dataPaths(root);
    this.randomSuffix = options.randomSuffix ?? (() => randomBytes(3).toString('hex'));
  }

  async createJob(
    spec: Omit<JobSpec, 'jobId' | 'createdAt'>,
    state: JobState,
    now: Date,
  ): Promise<JobSpec> {
    await mkdir(this.paths.jobs, { recursive: true });
    for (;;) {
      const jobId = formatJobId(now, this.randomSuffix());
      const files = this.paths.jobFiles(jobId);
      try {
        await mkdir(files.dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      const full = jobSpecSchema.parse({ ...spec, jobId, createdAt: now.toISOString() });
      // job.json を最後に置く: 一覧は job.json のあるディレクトリだけを数えるので、途中で落ちても半端なジョブが見えないため
      await writeJsonAtomic(files.state, jobStateSchema.parse(state));
      await writeJsonAtomic(files.spec, full);
      return full;
    }
  }

  async listJobIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of await listNames(this.paths.jobs)) {
      if (await exists(this.paths.jobFiles(name).spec)) ids.push(name);
    }
    return ids;
  }

  readJob(jobId: string): Promise<JobSpec> {
    return readValid(this.paths.jobFiles(jobId).spec, jobSpecSchema);
  }

  async writeJob(spec: JobSpec): Promise<void> {
    await writeJsonAtomic(this.paths.jobFiles(spec.jobId).spec, jobSpecSchema.parse(spec));
  }

  readState(jobId: string): Promise<JobState> {
    return readValid(this.paths.jobFiles(jobId).state, jobStateSchema);
  }

  async writeState(jobId: string, state: JobState): Promise<void> {
    await writeJsonAtomic(this.paths.jobFiles(jobId).state, jobStateSchema.parse(state));
  }

  readStage(jobId: string, iteration: number, stage: StageName): Promise<unknown> {
    return readJsonIfExists(this.paths.jobFiles(jobId).iteration(iteration)[stage]);
  }

  async writeStage(
    jobId: string,
    iteration: number,
    stage: StageName,
    value: unknown,
  ): Promise<void> {
    const files = this.paths.jobFiles(jobId).iteration(iteration);
    await mkdir(files.dir, { recursive: true });
    await writeJsonAtomic(files[stage], value);
  }

  async loadPreview(image: ImageRef, longEdge: number): Promise<PreviewImage> {
    const files = this.paths.jobFiles(image.jobId).iteration(image.iteration);
    const previewPath = files.preview(image.index, longEdge);
    let data: Uint8Array;
    try {
      data = await readFile(previewPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      data = await sharp(await readFile(files.image(image.index)))
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
        .webp()
        .toBuffer();
      await writeFileAtomic(previewPath, data);
    }
    const { width = 0, height = 0 } = await sharp(data).metadata();
    const sent = (await readJsonIfExists(files.sent(image.index))) as
      { callId: string } | undefined;
    return {
      key: this.imageKey(image),
      data,
      mediaType: 'image/webp',
      longEdge: Math.max(width, height),
      ...(sent === undefined ? {} : { sentInCall: sent.callId }),
    };
  }

  async markSent(image: ImageRef, callId: string, now: Date): Promise<void> {
    const path = this.paths.jobFiles(image.jobId).iteration(image.iteration).sent(image.index);
    const previous = (await readJsonIfExists(path)) as { callId: string } | undefined;
    // 上書きしない: 1枚を2回渡したことが、印を書き換えることで見えなくなるため
    if (previous !== undefined)
      throw new ImageAlreadySentError(this.imageKey(image), previous.callId);
    await writeJsonAtomic(path, { callId, sentAt: now.toISOString() });
  }

  async writeLlmCall(record: LlmCallRecord): Promise<void> {
    const dir =
      record.jobId === null ? this.paths.llmCalls : this.paths.jobFiles(record.jobId).llmCalls;
    const path =
      record.jobId === null
        ? this.paths.llmCall(record.callId)
        : this.paths.jobFiles(record.jobId).llmCall(record.callId);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(path, record);
  }

  async listLlmCalls(jobId: string | null): Promise<LlmCallRecord[]> {
    const dir = jobId === null ? this.paths.llmCalls : this.paths.jobFiles(jobId).llmCalls;
    const names = (await listNames(dir)).filter((name) => name.endsWith('.json'));
    const records: LlmCallRecord[] = [];
    for (const name of names) records.push((await readJson(join(dir, name))) as LlmCallRecord);
    return records;
  }

  /** データディレクトリからの相対で、拡張子の無い形（記録と UI で画像を指す） */
  private imageKey(image: ImageRef): string {
    const dir = this.paths.jobFiles(image.jobId).iteration(image.iteration).images;
    return `${relative(this.paths.root, dir).split('\\').join('/')}/${image.index}`;
  }
}
