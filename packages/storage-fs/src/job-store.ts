import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  adoptedRecordSchema,
  generationRequestSchema,
  interventionRecordSchema,
  isReferenceImageRef,
  jobSpecSchema,
  jobStateSchema,
  parseImageKey,
  referenceRecordSchema,
  selectionRecordSchema,
  type AdoptedRecord,
  type AnyImageRef,
  type GenerationRequest,
  type GenerationResult,
  type ImageRef,
  type InputImage,
  type InterventionRecord,
  type MaskIntervention,
  type NewMask,
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
  type SelectionRecord,
  type StageName,
  type StoredGeneration,
} from '@drawroid/core';
import sharp from 'sharp';
import { z, type ZodType } from 'zod';

import { createJsonExclusive, writeFileAtomic, writeJsonAtomic } from './atomic.js';
import { dataPaths, TEMP_FILE_PREFIX, type DataPaths } from './paths.js';
import { makePreview, PREVIEW_MEDIA_TYPE } from './preview.js';

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

// 画面の一覧と合計が読む欄だけを調べる: 全欄を調べると、記録の形を足すたびに古い記録が読めなくなるため
const llmCallRecordShape = z
  .object({
    callId: z.string(),
    iteration: z.number().nullable(),
    role: z.string(),
    purpose: z.string(),
    provider: z.string(),
    model: z.string(),
    startedAt: z.string(),
    durationMs: z.number(),
    usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable() }),
    attempts: z.array(z.unknown()),
    outcome: z.object({ ok: z.boolean() }).loose(),
  })
  .loose();

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

  async createJob(
    spec: NewJobSpec,
    state: JobState,
    now: Date,
    references: readonly NewReference[] = [],
  ): Promise<JobSpec> {
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
      // 参照画像も job.json より先に置く: ランナーがジョブを見つけた時点で、最初の回の境目に要点にできるように
      for (const reference of references) await this.addReference(jobId, reference, now);
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

  async listIterations(jobId: string): Promise<number[]> {
    return (await listNames(this.jobFiles(jobId).iterations))
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
  }

  async listGenerations(jobId: string): Promise<StoredGeneration[]> {
    const iterations = await this.listIterations(jobId);
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
    if (record.kind === 'instruction') {
      await writeJsonAtomic(path, { ...record, appliedInIteration: iteration });
      return;
    }
    if (record.kind === 'adopt') {
      await writeJsonAtomic(path, { ...record, takenAfterIteration: iteration });
      return;
    }
    throw new StoredFileError(
      path,
      new Error('人間の指示・選択ではないので、取り込んだ印を持たない'),
    );
  }

  async addMask(jobId: string, mask: NewMask, now: Date): Promise<MaskIntervention> {
    const files = this.jobFiles(jobId);
    await mkdir(files.interventions, { recursive: true });
    await mkdir(files.masks, { recursive: true });
    // 口出しと同じ連番で番号を取る: マスクの受けた順を、ほかの口出しとの前後も含めて名前の順で表すため。
    // 番号を取ってから PNG を置く。PNG を置く前に落ちたマスクは、readMask が無いと返し、使われない
    for (;;) {
      const interventionId = formatSequenceId((await this.lastSequence(files.interventions)) + 1);
      const record = interventionRecordSchema.parse({
        kind: 'mask',
        interventionId,
        receivedAt: now.toISOString(),
        image: mask.image,
      });
      if (!(await createJsonExclusive(files.intervention(interventionId), record))) continue;
      await writeFileAtomic(files.mask(interventionId), mask.data);
      return record as MaskIntervention;
    }
  }

  async readMask(jobId: string, maskId: string): Promise<Uint8Array | undefined> {
    if (!isSequenceId(maskId)) return undefined;
    try {
      return await readFile(this.jobFiles(jobId).mask(maskId));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async markMaskUsed(jobId: string, maskId: string, iteration: number): Promise<void> {
    if (!isSequenceId(maskId)) throw new Error(`maskId の形ではない: ${maskId}`);
    const path = this.jobFiles(jobId).intervention(maskId);
    const record = await readValid(path, interventionRecordSchema);
    if (record.kind !== 'mask') {
      throw new StoredFileError(path, new Error('マスクではないので、使った回を持たない'));
    }
    if (record.usedInIteration === iteration) return;
    await writeJsonAtomic(path, { ...record, usedInIteration: iteration });
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

  async readAdopted(jobId: string, iteration: number): Promise<AdoptedRecord | undefined> {
    const path = this.jobFiles(jobId).iteration(iteration).adopted;
    const raw = await readJsonIfExists(path);
    if (raw === undefined) return undefined;
    const parsed = adoptedRecordSchema.safeParse(raw);
    if (!parsed.success) throw new StoredFileError(path, parsed.error);
    return parsed.data;
  }

  async writeAdopted(jobId: string, iteration: number, record: AdoptedRecord): Promise<void> {
    const files = this.jobFiles(jobId).iteration(iteration);
    await mkdir(files.dir, { recursive: true });
    await writeJsonAtomic(files.adopted, adoptedRecordSchema.parse(record));
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
      data = await makePreview(await readFile(source), longEdge);
      await writeFileAtomic(preview, data);
    }
    const { width = 0, height = 0 } = await sharp(data).metadata();
    return {
      key: this.imageKey(image),
      data,
      mediaType: PREVIEW_MEDIA_TYPE,
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

  async writeSelection(jobId: string, selection: SelectionRecord): Promise<void> {
    const parsed = selectionRecordSchema.parse(selection);
    const files = this.jobFiles(jobId);
    await mkdir(files.selections, { recursive: true });
    await writeJsonAtomic(this.selectionPath(jobId, parsed.imageKey), parsed);
  }

  async readSelection(jobId: string, imageKey: string): Promise<SelectionRecord | undefined> {
    const path = this.selectionPath(jobId, imageKey);
    if (!(await exists(path))) return undefined;
    return readValid(path, selectionRecordSchema);
  }

  async listSelections(jobId: string): Promise<SelectionRecord[]> {
    const dir = this.jobFiles(jobId).selections;
    const names = (await listNames(dir)).filter((name) => name.endsWith('.json'));
    const records: SelectionRecord[] = [];
    for (const name of names) records.push(await readValid(join(dir, name), selectionRecordSchema));
    return records;
  }

  // 画像キーの形かを確かめてからパスを組む: 外から来たキーでジョブのディレクトリの外を指させないため
  private selectionPath(jobId: string, imageKey: string): string {
    if (parseImageKey(imageKey) === undefined) throw new Error(`画像キーの形ではない: ${imageKey}`);
    return this.jobFiles(jobId).selection(imageKey);
  }

  async addReference(jobId: string, reference: NewReference, now: Date): Promise<ReferenceRecord> {
    const files = this.jobFiles(jobId);
    await mkdir(files.refs, { recursive: true });
    // 口出しと同じく受けた順の連番にし、refs/<refId>.json を排他的に置いて番号を取る。
    // 画像のファイルで取り合わない: 拡張子が違うと、同じ番号を2件が取れてしまうため
    for (;;) {
      const refId = formatSequenceId((await this.lastSequence(files.refs)) + 1);
      const record = referenceRecordSchema.parse({
        refId,
        receivedAt: now.toISOString(),
        mediaType: reference.mediaType,
        ...(reference.note === undefined ? {} : { note: reference.note }),
      });
      if (!(await createJsonExclusive(files.refMeta(refId), record))) continue;
      await writeFileAtomic(files.ref(refId, extensionOf(record.mediaType)), reference.data);
      return record;
    }
  }

  async listReferences(jobId: string): Promise<ReferenceRecord[]> {
    const files = this.jobFiles(jobId);
    const records: ReferenceRecord[] = [];
    for (const name of await this.sequenceNames(files.refs)) {
      const record = await readValid(join(files.refs, name), referenceRecordSchema);
      // 番号を取ったあと画像を置く前に落ちた参照は見せない: 渡す画像が無いため
      if (await exists(files.ref(record.refId, extensionOf(record.mediaType))))
        records.push(record);
    }
    return records;
  }

  async writeReferenceGist(jobId: string, refId: string, gist: string): Promise<void> {
    const path = this.refFiles(jobId, refId).meta;
    const record = await readValid(path, referenceRecordSchema);
    await writeJsonAtomic(path, referenceRecordSchema.parse({ ...record, gist }));
  }

  async readReferenceImage(image: ReferenceImageRef): Promise<InputImage | undefined> {
    if (!isJobId(image.jobId) || !isSequenceId(image.refId)) return undefined;
    const files = this.refFiles(image.jobId, image.refId);
    const record = await readJsonIfExists(files.meta);
    if (record === undefined) return undefined;
    const { mediaType } = referenceRecordSchema.parse(record);
    try {
      return { data: await readFile(files.image(mediaType)), mediaType };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
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

  async listLlmCallRecords(jobId: string | null) {
    const dir = jobId === null ? this.paths.llmCalls : this.jobFiles(jobId).llmCalls;
    const records: LlmCallRecord[] = [];
    const invalid: { callId: string; reason: string }[] = [];
    for (const name of (await listNames(dir)).filter((n) => n.endsWith('.json'))) {
      try {
        const parsed = llmCallRecordShape.safeParse(await readJson(join(dir, name)));
        if (!parsed.success) throw new StoredFileError(join(dir, name), parsed.error);
        records.push(parsed.data as unknown as LlmCallRecord);
      } catch (error) {
        if (!(error instanceof StoredFileError)) throw error;
        invalid.push({ callId: name.slice(0, -'.json'.length), reason: error.message });
      }
    }
    return { records, invalid };
  }

  /** データディレクトリからの相対で、拡張子の無い形（記録と UI で画像を指す） */
  private imageKey(image: AnyImageRef): string {
    const files = this.jobFiles(image.jobId);
    const [dir, name] = isReferenceImageRef(image)
      ? [files.refs, image.refId]
      : [files.iteration(image.iteration).images, String(image.index)];
    return `${relative(this.paths.root, dir).split('\\').join('/')}/${name}`;
  }

  // 連番の形かを確かめてからパスを組む: 外から来た refId でデータディレクトリの外を指させないため
  private refFiles(jobId: string, refId: string) {
    if (!isSequenceId(refId)) throw new Error(`refId の形ではない: ${refId}`);
    const files = this.jobFiles(jobId);
    return {
      meta: files.refMeta(refId),
      image: (mediaType: ReferenceRecord['mediaType']) => files.ref(refId, extensionOf(mediaType)),
      preview: (longEdge: number) => files.refPreview(refId, longEdge),
    };
  }
}
