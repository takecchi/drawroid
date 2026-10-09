import { z } from 'zod';

import type { GenerationProgress } from '../backend.js';

export type ProgressPreview = NonNullable<GenerationProgress['preview']>;

/** config.json の generationProgress。途中の画像は既定で流さない */
export const generationProgressSettingsSchema = z.strictObject({ includePreview: z.boolean() });
export type GenerationProgressSettings = z.infer<typeof generationProgressSettingsSchema>;
export const DEFAULT_GENERATION_PROGRESS_SETTINGS: GenerationProgressSettings = {
  includePreview: false,
};

/**
 * 生成の途中の画像を、メモリに1枚だけ持つ置き場。ファイルには書かない。
 * ジョブごとの Map にしない: 生成はバックエンドで直列なので同時に1つしか無く、終わったジョブの画像が残り続けないようにするため。
 */
export class ProgressPreviews {
  #current: { jobId: string; preview: ProgressPreview } | undefined;

  set(jobId: string, preview: ProgressPreview): void {
    this.#current = { jobId, preview };
  }

  get(jobId: string): ProgressPreview | undefined {
    return this.#current?.jobId === jobId ? this.#current.preview : undefined;
  }

  clear(jobId: string): void {
    if (this.#current?.jobId === jobId) this.#current = undefined;
  }
}
