import { z } from 'zod';

import type { JobStore } from '../job/store.js';
import type { JudgeOutput } from '../loop/schemas.js';

export const SELECTION_VERDICTS = ['favorite', 'rejected'] as const;
export const selectionVerdictSchema = z.enum(SELECTION_VERDICTS);
export type SelectionVerdict = z.infer<typeof selectionVerdictSchema>;

/**
 * 回の画像を指すキー（`<回>-<画像>`。Issue #5 の J の案）。selections/<imageKey>.json の名前にもなる。
 */
// データディレクトリからのパス（jobs/<jobId>/iterations/...）にしない: ジョブの中で閉じた名前にして、ファイル名にそのまま使えるようにするため
export type ImageKey = string;

const IMAGE_KEY_PATTERN = /^([1-9]\d*)-(\d+)$/;

export function formatImageKey(image: { iteration: number; index: number }): ImageKey {
  return `${image.iteration}-${image.index}`;
}

/** 画像キーの形でなければ undefined */
export function parseImageKey(key: string): { iteration: number; index: number } | undefined {
  const match = IMAGE_KEY_PATTERN.exec(key);
  if (match === null) return undefined;
  return { iteration: Number(match[1]), index: Number(match[2]) };
}

/** selections/<imageKey>.json の中身。人間の最終選択1件 */
export const selectionRecordSchema = z.object({
  imageKey: z.string().regex(IMAGE_KEY_PATTERN),
  /** null は選択を外したこと */
  verdict: selectionVerdictSchema.nullable(),
  /** 選び直したときの、変わる前の選択。初めて選んだときは無い */
  previous: selectionVerdictSchema.nullable().optional(),
  selectedAt: z.iso.datetime({ offset: true }),
});
export type SelectionRecord = z.infer<typeof selectionRecordSchema>;

/**
 * 蒸留（#25）に渡す、選択1件とその画像の評価の短い欄。画像そのものは含めない。
 */
// #25 の SelectionMaterial と同じ形にしてある。両方が入ったときに、後から入る側が1つにまとめる
export type SelectionSummary = {
  imageKey: ImageKey;
  verdict: SelectionVerdict | null;
  previous?: SelectionVerdict | null;
  score?: number;
  issues: string[];
};

export class ImageNotFoundError extends Error {
  constructor(jobId: string, imageKey: string) {
    super(`ジョブ ${jobId} に画像 ${imageKey} は無い`);
    this.name = 'ImageNotFoundError';
  }
}

/**
 * 回の画像に、お気に入り・却下の印を付ける（null で外す）。選び直しのときは、変わる前の選択を残す。
 */
export async function selectImage(args: {
  store: JobStore;
  jobId: string;
  imageKey: string;
  verdict: SelectionVerdict | null;
  now: Date;
}): Promise<SelectionRecord> {
  const { store, jobId, imageKey, verdict, now } = args;
  const image = parseImageKey(imageKey);
  if (image === undefined) throw new ImageNotFoundError(jobId, imageKey);
  const generation = await store.readGeneration(jobId, image.iteration);
  if (!generation?.images.some((stored) => stored.index === image.index)) {
    throw new ImageNotFoundError(jobId, imageKey);
  }
  const before = await store.readSelection(jobId, imageKey);
  const record: SelectionRecord = {
    imageKey,
    verdict,
    ...(before === undefined ? {} : { previous: before.verdict }),
    selectedAt: now.toISOString(),
  };
  await store.writeSelection(jobId, record);
  return record;
}

/** ジョブの選択を、その画像の評価（その回の judge.json の点数と問題点）と合わせて、画像キーの順に返す */
export async function summarizeSelections(
  store: JobStore,
  jobId: string,
): Promise<SelectionSummary[]> {
  const summaries: SelectionSummary[] = [];
  const judgements = new Map<number, JudgeOutput | undefined>();
  const records = (await store.listSelections(jobId)).flatMap((record) => {
    const image = parseImageKey(record.imageKey);
    return image === undefined ? [] : [{ record, image }];
  });
  // 名前の文字列の順にしない: 10-0 が 2-0 より前に来るため
  records.sort((a, b) => a.image.iteration - b.image.iteration || a.image.index - b.image.index);
  for (const { record, image } of records) {
    if (!judgements.has(image.iteration)) {
      judgements.set(
        image.iteration,
        (await store.readStage(jobId, image.iteration, 'judge')) as JudgeOutput | undefined,
      );
    }
    const judged = judgements.get(image.iteration)?.images[image.index];
    summaries.push({
      imageKey: record.imageKey,
      verdict: record.verdict,
      ...(record.previous === undefined ? {} : { previous: record.previous }),
      ...(judged === undefined ? {} : { score: judged.score }),
      issues: judged?.issues ?? [],
    });
  }
  return summaries;
}
