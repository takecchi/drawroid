import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  generationRequestSchema,
  interventionRecordSchema,
  isReferenceImageRef,
  jobSpecSchema,
  jobStateSchema,
  referenceRecordSchema,
  type AnyImageRef,
  type GenerationRequest,
  type GenerationResult,
  type ImageRef,
  type InterventionRecord,
  type JobSpec,
  type JobState,
  type JobStore,
  type LlmCallRecord,
  type NewIntervention,
  type NewJobSpec,
  type NewReference,
  type PreviewImage,
  type ReferenceImageRef,
  type ReferenceRecord,
  type StageName,
  type StoredGeneration,
} from '@drawroid/core';
import sharp from 'sharp';
import { z, type ZodType } from 'zod';

import { createJsonExclusive, writeFileAtomic, writeJsonAtomic } from './atomic.js';
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

const EXTENSIONS: Record<ReferenceRecord['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function extensionOf(mediaType: ReferenceRecord['mediaType']): string {
  return EXTENSIONS[mediaType];
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

// 0 で埋める: 名前の順で並べても番号の順になり、人間がディレクトリを開いて読めるように
const SEQUENCE_DIGITS = 6;
const SEQUENCE_ID_PATTERN = /^\d{6,}$/;

/** ジョブの中で受けた順に振る番号（口出しの ID） */
export function formatSequenceId(sequence: number): string {
  return String(sequence).padStart(SEQUENCE_DIGITS, '0');
}

/** パスに使ってよい連番の形か */
export function isSequenceId(value: string): boolean {
  return SEQUENCE_ID_PATTERN.test(value);
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

  async addIntervention(
    jobId: string,
    intervention: NewIntervention,
    now: Date,
  ): Promise<InterventionRecord> {
    const files = this.jobFiles(jobId);
    await mkdir(files.interventions, { recursive: true });
    // 受けた順の連番にする: 時刻と乱数の名前だと、同じ秒に受けた2件の名前の順が受けた順にならず、
    // 止める条件の変更を重ねる順や人間の指示の順が入れ替わるため。
    // 同じ番号を同時に取りに来たら、排他的に置けなかった側が次の番号を取り直す
    for (;;) {
      const interventionId = formatSequenceId((await this.lastSequence(files.interventions)) + 1);
      const record = interventionRecordSchema.parse({
        ...intervention,
        interventionId,
        receivedAt: now.toISOString(),
      });
      if (await createJsonExclusive(files.intervention(interventionId), record)) return record;
    }
  }

  async listInterventions(jobId: string): Promise<InterventionRecord[]> {
    const files = this.jobFiles(jobId);
    const records: InterventionRecord[] = [];
    for (const name of await this.sequenceNames(files.interventions)) {
      records.push(await readValid(join(files.interventions, name), interventionRecordSchema));
    }
    return records;
  }

  /** 連番の名前のファイルを、番号の順に返す */
  private async sequenceNames(dir: string): Promise<string[]> {
    return (await listNames(dir))
      .filter((name) => name.endsWith('.json') && isSequenceId(name.slice(0, -'.json'.length)))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  }

  private async lastSequence(dir: string): Promise<number> {
    const names = await this.sequenceNames(dir);
    const last = names.at(-1);
    return last === undefined ? 0 : Number.parseInt(last, 10);
  }

  async markInterventionApplied(
    jobId: string,
    interventionId: string,
    iteration: number,
  ): Promise<void> {
    // 連番の形かを確かめてからパスを組む: 外から来た ID でジョブのディレクトリの外を指させないため
    if (!isSequenceId(interventionId)) {
      throw new Error(`interventionId の形ではない: ${interventionId}`);
    }
    const path = this.jobFiles(jobId).intervention(interventionId);
    const record = await readValid(path, interventionRecordSchema);
    if (record.kind !== 'instruction') {
      throw new StoredFileError(path, new Error('人間の指示ではないので、取り込んだ回を持たない'));
    }
    await writeJsonAtomic(path, { ...record, appliedInIteration: iteration });
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

  async loadPreview(image: AnyImageRef, longEdge: number): Promise<PreviewImage> {
    const { source, preview, sentInCall } = isReferenceImageRef(image)
      ? await this.referenceImageFiles(image, longEdge)
      : await this.generatedImageFiles(image, longEdge);
    let data: Uint8Array;
    try {
      data = await readFile(preview);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      data = await sharp(await readFile(source))
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
        .webp()
        .toBuffer();
      await writeFileAtomic(preview, data);
    }
    const { width = 0, height = 0 } = await sharp(data).metadata();
    return {
      key: this.imageKey(image),
      data,
      mediaType: 'image/webp',
      longEdge: Math.max(width, height),
      ...(sentInCall === undefined ? {} : { sentInCall }),
    };
  }

  async markSent(image: AnyImageRef, callId: string, now: Date): Promise<void> {
    if (isReferenceImageRef(image)) {
      const path = this.refFiles(image.jobId, image.refId).meta;
      const record = await readValid(path, referenceRecordSchema);
      if (record.sentInCall !== undefined) {
        throw new ImageAlreadySentError(this.imageKey(image), record.sentInCall);
      }
      await writeJsonAtomic(path, { ...record, sentInCall: callId, sentAt: now.toISOString() });
      return;
    }
    const path = this.jobFiles(image.jobId).iteration(image.iteration).sent(image.index);
    const previous = (await readJsonIfExists(path)) as { callId: string } | undefined;
    // 上書きしない: 1枚を2回渡したことが、印を書き換えることで見えなくなるため
    if (previous !== undefined)
      throw new ImageAlreadySentError(this.imageKey(image), previous.callId);
    await writeJsonAtomic(path, { callId, sentAt: now.toISOString() });
  }

  async addReference(jobId: string, reference: NewReference, now: Date): Promise<ReferenceRecord> {
    const files = this.jobFiles(jobId);
    await mkdir(files.refs, { recursive: true });
    for (;;) {
      const refId = formatJobId(now, this.randomSuffix());
      if (await exists(files.refMeta(refId))) continue;
      const record = referenceRecordSchema.parse({
        refId,
        receivedAt: now.toISOString(),
        mediaType: reference.mediaType,
        ...(reference.note === undefined ? {} : { note: reference.note }),
      });
      // 画像を先に、refs/<refId>.json を後に置く: 一覧は .json だけを数えるので、途中で落ちても画像の無い参照が見えないため
      await writeFileAtomic(files.ref(refId, extensionOf(record.mediaType)), reference.data);
      await writeJsonAtomic(files.refMeta(refId), record);
      return record;
    }
  }

  async listReferences(jobId: string): Promise<ReferenceRecord[]> {
    const files = this.jobFiles(jobId);
    const names = (await listNames(files.refs)).filter((name) => name.endsWith('.json'));
    const records: ReferenceRecord[] = [];
    for (const name of names) {
      records.push(await readValid(join(files.refs, name), referenceRecordSchema));
    }
    return records;
  }

  async writeReferenceGist(jobId: string, refId: string, gist: string): Promise<void> {
    const path = this.refFiles(jobId, refId).meta;
    const record = await readValid(path, referenceRecordSchema);
    await writeJsonAtomic(path, referenceRecordSchema.parse({ ...record, gist }));
  }

  private async generatedImageFiles(image: ImageRef, longEdge: number) {
    const files = this.jobFiles(image.jobId).iteration(image.iteration);
    const sent = (await readJsonIfExists(files.sent(image.index))) as
      { callId: string } | undefined;
    return {
      source: files.image(image.index),
      preview: files.preview(image.index, longEdge),
      sentInCall: sent?.callId,
    };
  }

  private async referenceImageFiles(image: ReferenceImageRef, longEdge: number) {
    const files = this.refFiles(image.jobId, image.refId);
    const record = await readValid(files.meta, referenceRecordSchema);
    return {
      source: files.image(record.mediaType),
      preview: files.preview(longEdge),
      sentInCall: record.sentInCall,
    };
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
  private imageKey(image: AnyImageRef): string {
    const files = this.jobFiles(image.jobId);
    const [dir, name] = isReferenceImageRef(image)
      ? [files.refs, image.refId]
      : [files.iteration(image.iteration).images, String(image.index)];
    return `${relative(this.paths.root, dir).split('\\').join('/')}/${name}`;
  }

  // refId も jobId と同じ形なので、同じ検査を通してからパスを組む: 外から来た refId でデータディレクトリの外を指させないため
  private refFiles(jobId: string, refId: string) {
    if (!isJobId(refId)) throw new Error(`refId の形ではない: ${refId}`);
    const files = this.jobFiles(jobId);
    return {
      meta: files.refMeta(refId),
      image: (mediaType: ReferenceRecord['mediaType']) => files.ref(refId, extensionOf(mediaType)),
      preview: (longEdge: number) => files.refPreview(refId, longEdge),
    };
  }
}
