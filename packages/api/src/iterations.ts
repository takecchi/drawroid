import {
  type AdoptedRecord,
  type ExcludedParam,
  type GenerationRequest,
  iterationPlanSchema,
  type JobStore,
} from '@drawroid/core';
import { z } from 'zod';

export type ImageView = { index: number; seed: number | null; url: string; previewUrl: string };

export type IterationView = {
  iteration: number;
  think: unknown;
  /** その回に AI の選択肢から外したもの。plan.json が無い回は null */
  excluded: ExcludedParam[] | null;
  request: GenerationRequest | null;
  judge: unknown;
  /** 人間がこの回の画像を選んで見る役を省いた回の記録。選んでいない回は null */
  adopted: AdoptedRecord | null;
  images: ImageView[];
};

export type InvalidIteration = { iteration: number; reason: string };

export function imageUrls(jobId: string, iteration: number, index: number) {
  const base = `/api/files/jobs/${jobId}/iterations/${iteration}/images/${index}`;
  return { url: `${base}.png`, previewUrl: `${base}.preview.webp` };
}

/** 1つのファイルでも読めなければ throw する。呼び手が、その回だけを外すか 422 にするかを決める */
export async function readIterationView(
  store: JobStore,
  jobId: string,
  iteration: number,
): Promise<IterationView> {
  const [think, plan, judge, adopted, generation] = await Promise.all([
    store.readStage(jobId, iteration, 'think'),
    store.readStage(jobId, iteration, 'plan'),
    store.readStage(jobId, iteration, 'judge'),
    store.readAdopted(jobId, iteration),
    store.readGeneration(jobId, iteration),
  ]);
  return {
    iteration,
    think: think ?? null,
    excluded: plan === undefined ? null : iterationPlanSchema.parse(plan).excluded,
    request: generation?.request ?? null,
    judge: judge ?? null,
    adopted: adopted ?? null,
    images: (generation?.images ?? []).map(({ index, seed }) => ({
      index,
      seed,
      ...imageUrls(jobId, iteration, index),
    })),
  };
}

// 回ごとに捕まえる: 壊れた1回のために、ほかの回まで見えなくならないようにするため
export async function readAllIterationViews(
  store: JobStore,
  jobId: string,
): Promise<{ iterations: IterationView[]; invalid: InvalidIteration[] }> {
  const iterations: IterationView[] = [];
  const invalid: InvalidIteration[] = [];
  for (const iteration of await store.listIterations(jobId)) {
    try {
      iterations.push(await readIterationView(store, jobId, iteration));
    } catch (error) {
      invalid.push({ iteration, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { iterations, invalid };
}

const judgeSummarySchema = z.object({
  canStop: z.boolean(),
  images: z.array(z.object({ score: z.number() })),
});

export type JudgeSummary = { canStop: boolean; scores: number[]; adopted?: true };

export function summarizeJudge(judge: unknown): JudgeSummary | null {
  const parsed = judgeSummarySchema.safeParse(judge);
  if (!parsed.success) return null;
  return { canStop: parsed.data.canStop, scores: parsed.data.images.map((image) => image.score) };
}

/**
 * 人が画像を選んで見る役を済ませた回（adopted.json）の要約。点数は runner と同じく、選んだ画像だけ 1、ほかは 0。
 * canStop は AI の判断の欄なので、人が選んだ回では立てない
 */
export function summarizeAdopted(
  adopted: AdoptedRecord | null,
  iteration: number,
  imageCount: number,
): JudgeSummary | null {
  if (adopted === null) return null;
  const chosen = adopted.image.iteration === iteration ? adopted.image.index : undefined;
  return {
    canStop: false,
    scores: Array.from({ length: imageCount }, (_, index) => (index === chosen ? 1 : 0)),
    adopted: true,
  };
}
