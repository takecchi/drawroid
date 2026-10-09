import type { GenerationProgress, ImageBackend } from '../backend.js';
import type { LiveEvent } from './events.js';

type ProgressEvent = Extract<LiveEvent, { type: 'generation.progress' }>;
type Preview = NonNullable<GenerationProgress['preview']>;

export type ProgressPollingOptions = {
  backend: Pick<ImageBackend, 'progress'>;
  jobId: string;
  iteration: number;
  emit: (event: ProgressEvent) => void;
  /** 外からの中断。生成の signal を渡す想定 */
  signal: AbortSignal;
  /** 既定 1000 */
  intervalMs?: number;
  /** 既定 false。true のときだけ、バックエンドに途中の画像を求める */
  includePreview?: boolean;
  /** 途中の画像の受け取り先（置き場へ入れる想定） */
  onPreview?: (preview: Preview) => void;
  /** includePreview で途中の画像があるときに、イベントへ載せる URL */
  previewUrl?: string;
  /** 試験で偽の時計に差し替える。既定は setTimeout で、signal の中断で即座に解ける */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
};

export type ProgressPolling = {
  /** 走っている読みが終わるまで待ってから解ける。2回呼んでよい */
  stop(): Promise<void>;
};

const DEFAULT_INTERVAL_MS = 1000;

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

function toEvent(
  progress: GenerationProgress,
  options: Pick<ProgressPollingOptions, 'jobId' | 'iteration' | 'previewUrl'>,
  withPreview: boolean,
): ProgressEvent {
  const event: ProgressEvent = {
    type: 'generation.progress',
    jobId: options.jobId,
    iteration: options.iteration,
    progress: progress.fraction,
  };
  if (progress.step !== null) event.step = progress.step;
  if (progress.steps !== null && progress.steps >= 1) event.steps = progress.steps;
  if (progress.etaSeconds !== null) event.etaMs = progress.etaSeconds * 1000;
  if (withPreview && options.previewUrl !== undefined) event.previewUrl = options.previewUrl;
  return event;
}

/**
 * 生成を待つ間、バックエンドの進み具合を一定の間隔で読み、generation.progress として emit する。LLM は通さない。
 * 進み具合は生成の付け足しなので、読みの失敗では生成を止めず、onError へ渡して次の間隔でまた読む。
 *
 * 会話 F の橋渡し（ジョブ実行器からハブへ）が、generate の前に start し、後で stop する想定。
 * generate の signal を渡せば、中断でも止まる。stop のあとは emit しない。
 */
export function startProgressPolling(options: ProgressPollingOptions): ProgressPolling {
  const { backend, signal: outer, onPreview, onError } = options;
  const progress = backend.progress?.bind(backend);
  if (progress === undefined) return { stop: async () => undefined };

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const includePreview = options.includePreview ?? false;
  const wait = options.wait ?? defaultWait;
  const controller = new AbortController();
  const signal = AbortSignal.any([outer, controller.signal]);

  const loop = async (): Promise<void> => {
    while (!signal.aborted) {
      await wait(intervalMs, signal);
      if (signal.aborted) return;
      try {
        const value = await progress(signal, { includePreview });
        if (signal.aborted) return;
        if (value === undefined) continue;
        let attachPreview = false;
        if (includePreview && value.preview !== undefined) {
          onPreview?.(value.preview);
          attachPreview = true;
        }
        options.emit(toEvent(value, options, attachPreview));
      } catch (error) {
        if (signal.aborted) return;
        onError?.(error);
      }
    }
  };
  const running = loop();

  return {
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}
