import type { ImageBackend } from '../backend.js';
import type { LiveEvent } from './events.js';
import { startProgressPolling, type ProgressPolling } from './progress-poller.js';
import type { ProgressPreviews } from './progress-preview.js';

export type GenerationProgressStart = {
  jobId: string;
  conversationId: string | undefined;
  iteration: number;
  /** 生成の signal。中断でも読みが止まる */
  signal: AbortSignal;
};

/** ジョブ実行器が、生成を待つ間だけ進み具合を流すための口 */
export type GenerationProgressPort = {
  start(args: GenerationProgressStart): Promise<ProgressPolling>;
};

export type GenerationProgressDeps = {
  backend: Pick<ImageBackend, 'progress'>;
  hubs: { get(conversationId: string): { live(event: LiveEvent): void } };
  previews: ProgressPreviews;
  /** 読むたびに最新の設定を返す。失敗したら途中の画像なしで流す */
  settings: () => Promise<{ includePreview: boolean }>;
  intervalMs?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
};

const NOT_POLLING: ProgressPolling = { stop: async () => undefined };

/**
 * 会話に属するジョブの生成の進み具合を、その会話のハブへ流す。LLM は通さず、ファイルにも書かない。
 * 会話に属さないジョブには何も流さない。
 */
export function createGenerationProgress(deps: GenerationProgressDeps): GenerationProgressPort {
  return {
    start: async ({ jobId, conversationId, iteration, signal }) => {
      if (conversationId === undefined) return NOT_POLLING;
      let includePreview = false;
      try {
        includePreview = (await deps.settings()).includePreview;
      } catch (error) {
        // 読めない設定のときは、途中の画像を流さない側へ倒す
        deps.onError?.(error);
      }
      let hub: { live(event: LiveEvent): void };
      try {
        hub = deps.hubs.get(conversationId);
      } catch (error) {
        // ハブが引けなくても生成は止めない: 進み具合は付け足しで、ジョブの失敗の理由にしないため
        deps.onError?.(error);
        return NOT_POLLING;
      }
      const polling = startProgressPolling({
        backend: deps.backend,
        jobId,
        iteration,
        signal,
        includePreview,
        emit: (event) => hub.live(event),
        onPreview: (preview) => deps.previews.set(jobId, preview),
        previewUrl: `/api/jobs/${jobId}/progress-preview`,
        ...(deps.intervalMs !== undefined && { intervalMs: deps.intervalMs }),
        ...(deps.wait !== undefined && { wait: deps.wait }),
        ...(deps.onError !== undefined && { onError: deps.onError }),
      });
      return {
        stop: async () => {
          await polling.stop();
          deps.previews.clear(jobId);
        },
      };
    },
  };
}
