import {
  createGenerationProgress,
  ProgressPreviews,
  type GenerationProgressDeps,
  type GenerationProgressPort,
} from '@drawroid/core';
import type { GenerationProgressSettingsPort } from '@drawroid/api';

/**
 * 生成の進み具合の部品を組む。途中の画像の置き場（ProgressPreviews）はここで1つだけ作り、
 * ジョブ実行器（書く側）と API（読む側）に同じものを渡す。
 */
// 別々に作ると、ジョブ実行器が置いた途中の画像を API が読めず、画面の途中の画像がいつも 404 になるため
export function wireGenerationProgress(deps: {
  backend: GenerationProgressDeps['backend'];
  hubs: GenerationProgressDeps['hubs'];
  settings: GenerationProgressSettingsPort;
  onError: (error: unknown) => void;
}): {
  /** ジョブ実行器（AutoJobQueue）に渡す */
  generationProgress: GenerationProgressPort;
  /** API の deps に渡す */
  api: {
    progressPreviews: ProgressPreviews;
    generationProgressSettings: GenerationProgressSettingsPort;
  };
} {
  const previews = new ProgressPreviews();
  return {
    generationProgress: createGenerationProgress({
      backend: deps.backend,
      hubs: deps.hubs,
      previews,
      settings: () => deps.settings.read(),
      onError: deps.onError,
    }),
    api: { progressPreviews: previews, generationProgressSettings: deps.settings },
  };
}
