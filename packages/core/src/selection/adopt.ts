import type { JobStore } from '../job/store.js';
import type { InterventionRecord } from '../job/types.js';
import { InterventionRejectedError } from '../loop/runner.js';
import { formatImageKey, selectImage } from './selection.js';

/** 人間が選んだ画像を採った結果 */
export type AdoptImageResult =
  { ok: true } | { ok: false; reason: 'no-image' | 'not-accepting'; message: string };

/**
 * 人間が選んだ画像をジョブに採らせ、お気に入りにする。会話の adopt_image と、画面の「採る」ボタン（API）が同じ口を通る。
 * - 画像が無ければ、何もせずに no-image
 * - ジョブが受け付けない（止まった・手動のジョブ）なら、何もせずに not-accepting
 * ジョブの実行器が受けた選択は、その回がまだ見る役に見られていなければ job.adopted として会話に確定する
 */
// ジョブに採らせてから、お気に入りを書く: 採らせる前にジョブが止まったら、何も書かずに失敗にするため（#159）。
// 選択を別の経路で書かない: 画面と会話で、採ったのにお気に入りでない・お気に入りなのに採っていない、を作らないため
export async function adoptImage(
  deps: {
    jobs: JobStore;
    runner: {
      adopt(
        jobId: string,
        image: { iteration: number; index: number },
      ): Promise<InterventionRecord>;
    };
    now: () => Date;
  },
  jobId: string,
  image: { iteration: number; index: number },
): Promise<AdoptImageResult> {
  const key = formatImageKey(image);
  const generation = await deps.jobs.readGeneration(jobId, image.iteration);
  if (generation === undefined || image.index >= generation.images.length) {
    return { ok: false, reason: 'no-image', message: `画像 ${key} は無い` };
  }
  try {
    await deps.runner.adopt(jobId, image);
  } catch (error) {
    if (error instanceof InterventionRejectedError) {
      return {
        ok: false,
        reason: 'not-accepting',
        message: `絵がもう止まっていて、画像 ${key} を採れなかった`,
      };
    }
    throw error;
  }
  await selectImage({
    store: deps.jobs,
    jobId,
    imageKey: key,
    verdict: 'favorite',
    now: deps.now(),
  });
  return { ok: true };
}
