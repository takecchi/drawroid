import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  generationRequestSchema,
  jobSpecSchema,
  jobStateSchema,
  type GenerationRequest,
  type GenerationResult,
  type ImageRef,
  type JobSpec,
  type JobState,
  type JobStore,
  type LlmCallRecord,
  type NewJobSpec,
  type PreviewImage,
  type StageName,
  type StoredGeneration,
} from '@drawroid/core';
import sharp from 'sharp';
import { z, type ZodType } from 'zod';

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

const imageMetaSchema = z.object({ seed: z.number().nullable() });

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

const JOB_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-z]+$/;

/** パスに使ってよい jobId の形か。外から来た文字列を、ディレクトリを抜ける形のままパスにしないための門 */
export function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
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

  // 外から来た jobId でパスを組む口はすべてここを通す: 呼び手の検査に頼ると、1か所の漏れでデータディレクトリの外を読み書きできるため
  private jobFiles(jobId: string) {
    if (!isJobId(jobId)) throw new Error(`jobId の形ではない: ${jobId}`);
    return this.paths.jobFiles(jobId);
  }

  async createJob(spec: NewJobSpec, state: JobState, now: Date): Promise<JobSpec> {
    await mkdir(this.paths.jobs, { recursive: true });
    for (;;) {
      const jobId = formatJobId(now, this.randomSuffix());
      const files = this.jobFiles(jobId);
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
    return readValid(this.jobFiles(jobId).spec, jobSpecSchema);
  }

  async writeJob(spec: JobSpec): Promise<void> {
    await writeJsonAtomic(this.jobFiles(spec.jobId).spec, jobSpecSchema.parse(spec));
  }

  readState(jobId: string): Promise<JobState> {
    return readValid(this.jobFiles(jobId).state, jobStateSchema);
  }

  async writeState(jobId: string, state: JobState): Promise<void> {
    await writeJsonAtomic(this.jobFiles(jobId).state, jobStateSchema.parse(state));
  }

  async writeGeneration(
    jobId: string,
    iteration: number,
    request: GenerationRequest,
    result: GenerationResult,
  ): Promise<void> {
    const files = this.jobFiles(jobId).iteration(iteration);
    await mkdir(files.images, { recursive: true });
    for (const [index, image] of result.images.entries()) {
      await writeFileAtomic(files.image(index), image.png);
      await writeJsonAtomic(files.imageMeta(index), {
        seed: image.seed,
        metadata: image.metadata,
        response: result.metadata,
      });
    }
    // request.json を最後に置く: 一覧は request.json のある回だけを数えるので、途中で落ちても画像が欠けた回が見えないため
    await writeJsonAtomic(files.request, request);
  }

  async listGenerations(jobId: string): Promise<StoredGeneration[]> {
    const files = this.jobFiles(jobId);
    const iterations = (await listNames(files.iterations))
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
    const generations: StoredGeneration[] = [];
    for (const iteration of iterations) {
      const generation = await this.readGeneration(jobId, iteration);
      if (generation !== undefined) generations.push(generation);
    }
    return generations;
  }

  async readGeneration(jobId: string, iteration: number): Promise<StoredGeneration | undefined> {
    const dir = this.jobFiles(jobId).iteration(iteration);
    if (!(await exists(dir.request))) return undefined;
    const images: StoredGeneration['images'] = [];
    const indexes = (await listNames(dir.images))
      .flatMap((name) => /^(\d+)\.png$/.exec(name)?.[1] ?? [])
      .map(Number)
      .sort((a, b) => a - b);
    for (const index of indexes) {
      const meta = await readValid(dir.imageMeta(index), imageMetaSchema);
      images.push({ index, seed: meta.seed });
    }
    return { iteration, request: await readValid(dir.request, generationRequestSchema), images };
  }

  async readImage(image: ImageRef): Promise<Uint8Array | undefined> {
    if (!isJobId(image.jobId)) return undefined;
    try {
      return await readFile(
        this.jobFiles(image.jobId).iteration(image.iteration).image(image.index),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  readStage(jobId: string, iteration: number, stage: StageName): Promise<unknown> {
    return readJsonIfExists(this.jobFiles(jobId).iteration(iteration)[stage]);
  }

  async writeStage(
    jobId: string,
    iteration: number,
    stage: StageName,
    value: unknown,
  ): Promise<void> {
    const files = this.jobFiles(jobId).iteration(iteration);
    await mkdir(files.dir, { recursive: true });
    await writeJsonAtomic(files[stage], value);
  }

  async loadPreview(image: ImageRef, longEdge: number): Promise<PreviewImage> {
    const files = this.jobFiles(image.jobId).iteration(image.iteration);
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
    const path = this.jobFiles(image.jobId).iteration(image.iteration).sent(image.index);
    const previous = (await readJsonIfExists(path)) as { callId: string } | undefined;
    // 上書きしない: 1枚を2回渡したことが、印を書き換えることで見えなくなるため
    if (previous !== undefined)
      throw new ImageAlreadySentError(this.imageKey(image), previous.callId);
    await writeJsonAtomic(path, { callId, sentAt: now.toISOString() });
  }

  async writeLlmCall(record: LlmCallRecord): Promise<void> {
    const dir = record.jobId === null ? this.paths.llmCalls : this.jobFiles(record.jobId).llmCalls;
    const path =
      record.jobId === null
        ? this.paths.llmCall(record.callId)
        : this.jobFiles(record.jobId).llmCall(record.callId);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(path, record);
  }

  async listLlmCalls(jobId: string | null): Promise<LlmCallRecord[]> {
    const dir = jobId === null ? this.paths.llmCalls : this.jobFiles(jobId).llmCalls;
    const names = (await listNames(dir)).filter((name) => name.endsWith('.json'));
    const records: LlmCallRecord[] = [];
    for (const name of names) records.push((await readJson(join(dir, name))) as LlmCallRecord);
    return records;
  }

  /** データディレクトリからの相対で、拡張子の無い形（記録と UI で画像を指す） */
  private imageKey(image: ImageRef): string {
    const dir = this.jobFiles(image.jobId).iteration(image.iteration).images;
    return `${relative(this.paths.root, dir).split('\\').join('/')}/${image.index}`;
  }
}
