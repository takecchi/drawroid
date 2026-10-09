import type { GenerationRequest, JobStore } from '@drawroid/core';
import { z } from 'zod';

export type ImageView = { index: number; seed: number | null; url: string; previewUrl: string };

export type IterationView = {
  iteration: number;
  think: unknown;
  request: GenerationRequest | null;
  judge: unknown;
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
  const [think, judge, generation] = await Promise.all([
    store.readStage(jobId, iteration, 'think'),
    store.readStage(jobId, iteration, 'judge'),
    store.readGeneration(jobId, iteration),
  ]);
  return {
    iteration,
    think: think ?? null,
    request: generation?.request ?? null,
    judge: judge ?? null,
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

export type JudgeSummary = { canStop: boolean; scores: number[] };

export function summarizeJudge(judge: unknown): JudgeSummary | null {
  const parsed = judgeSummarySchema.safeParse(judge);
  if (!parsed.success) return null;
  return { canStop: parsed.data.canStop, scores: parsed.data.images.map((image) => image.score) };
}
