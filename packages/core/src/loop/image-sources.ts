import {
  type GenerationImages,
  type GenerationRequest,
  type InputImage,
  type InputImageRef,
  inputImageRefsOf,
} from '../backend.js';
import type { JobStore } from '../job/store.js';
import type { InterventionRecord, MaskIntervention } from '../job/types.js';
import type { Carry } from './carry.js';

/**
 * 生成の要求に書く画像の参照の形。ジョブのディレクトリの中の画像を、置き方に依らずに指す。
 * 生成した画像は `image:<回>-<画像>`（Issue #5 の J の imageKey）、参照画像は `ref:<refId>`、マスクは `mask:<maskId>`。
 */
export function generatedImageRef(iteration: number, index: number): InputImageRef {
  return `image:${iteration}-${index}`;
}
export function referenceImageRef(refId: string): InputImageRef {
  return `ref:${refId}`;
}
export function maskImageRef(maskId: string): InputImageRef {
  return `mask:${maskId}`;
}

export type ParsedInputImageRef =
  | { kind: 'image'; iteration: number; index: number }
  | { kind: 'ref'; refId: string }
  | { kind: 'mask'; maskId: string };

export function parseInputImageRef(ref: InputImageRef): ParsedInputImageRef | undefined {
  const image = /^image:(\d+)-(\d+)$/.exec(ref);
  if (image !== null)
    return { kind: 'image', iteration: Number(image[1]), index: Number(image[2]) };
  const reference = /^ref:(.+)$/.exec(ref);
  if (reference?.[1] !== undefined) return { kind: 'ref', refId: reference[1] };
  const mask = /^mask:(.+)$/.exec(ref);
  if (mask?.[1] !== undefined) return { kind: 'mask', maskId: mask[1] };
  return undefined;
}

/** 考える役が元画像として選べるキー。best・latest は持ち回している結果、ref:<refId> は参照画像 */
export type ImageSourceKey = 'best' | 'latest' | `ref:${string}`;

/**
 * 持ち回している状態から、元画像に選べる画像のキーと参照を返す（Issue #5 の G）。
 */
// 画像そのものを考える役に見せない: 最良・直近・参照画像は、評価や要点のテキストとして入力に載っているので、
// それを指すキーだけで選ばせる
export function imageSourcesOf(carry: Carry): { key: ImageSourceKey; ref: InputImageRef }[] {
  const sources: { key: ImageSourceKey; ref: InputImageRef }[] = [];
  if (carry.best !== undefined) {
    sources.push({
      key: 'best',
      ref: generatedImageRef(carry.best.iteration, carry.best.imageIndex),
    });
  }
  if (carry.latest !== undefined && carry.latest.iteration !== carry.best?.iteration) {
    sources.push({
      key: 'latest',
      ref: generatedImageRef(carry.latest.iteration, carry.latest.imageIndex),
    });
  }
  for (const reference of carry.references ?? []) {
    sources.push({ key: `ref:${reference.refId}`, ref: referenceImageRef(reference.refId) });
  }
  return sources;
}

/**
 * いま有効なマスク。いちばん新しいマスクが、まだ inpaint に使われていなければそれ（Issue #5 の H）。
 */
// 古いマスクに戻らない: 新しいマスクが来た時点で、それより前のマスクは切れるため
export function activeMask(
  interventions: readonly InterventionRecord[],
): MaskIntervention | undefined {
  const masks = interventions.filter((i): i is MaskIntervention => i.kind === 'mask');
  const latest = masks.at(-1);
  return latest?.usedInIteration === undefined ? latest : undefined;
}

/**
 * 要求が指す画像の中身を、置き場所から読む。足りなければ、どれが無いかを挙げて投げる。
 */
export async function loadRequestImages(
  store: JobStore,
  jobId: string,
  request: GenerationRequest,
): Promise<GenerationImages> {
  const images = new Map<InputImageRef, InputImage>();
  const missing: InputImageRef[] = [];
  for (const ref of inputImageRefsOf(request)) {
    const image = await readInputImage(store, jobId, ref);
    if (image === undefined) missing.push(ref);
    else images.set(ref, image);
  }
  if (missing.length > 0) throw new Error(`要求が指す画像が無い: ${missing.join(', ')}`);
  return images;
}

async function readInputImage(
  store: JobStore,
  jobId: string,
  ref: InputImageRef,
): Promise<InputImage | undefined> {
  const parsed = parseInputImageRef(ref);
  if (parsed === undefined) return undefined;
  switch (parsed.kind) {
    case 'image': {
      const data = await store.readImage({
        jobId,
        iteration: parsed.iteration,
        index: parsed.index,
      });
      return data === undefined ? undefined : { data, mediaType: 'image/png' };
    }
    case 'ref':
      return store.readReferenceImage({ jobId, refId: parsed.refId });
    case 'mask': {
      const data = await store.readMask(jobId, parsed.maskId);
      return data === undefined ? undefined : { data, mediaType: 'image/png' };
    }
  }
}
