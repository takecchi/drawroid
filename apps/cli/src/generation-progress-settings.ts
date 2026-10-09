import type { GenerationProgressSettingsPort } from '@drawroid/api';
import {
  DEFAULT_GENERATION_PROGRESS_SETTINGS,
  generationProgressSettingsSchema,
} from '@drawroid/core';
import {
  readGenerationProgressSettings,
  writeGenerationProgressSettings,
} from '@drawroid/storage-fs';

/** config.json の generationProgress を、読むたびに検証する。無ければ既定（途中の画像は流さない） */
export function createGenerationProgressSettings(
  configPath: string,
): GenerationProgressSettingsPort {
  return {
    read: async () => {
      const stored = await readGenerationProgressSettings(configPath);
      if (stored === undefined) return DEFAULT_GENERATION_PROGRESS_SETTINGS;
      const parsed = generationProgressSettingsSchema.safeParse(stored);
      // 読めない設定を既定で置き換えない: 無効のつもりの途中の画像が流れる側へ倒れないよう、理由を付けて投げる
      if (!parsed.success) {
        const reason = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(generationProgress)'}: ${issue.message}`)
          .join('; ');
        throw new Error(`config.json の generationProgress が不正: ${reason}`);
      }
      return parsed.data;
    },
    write: async (settings) => {
      await writeGenerationProgressSettings(configPath, settings);
    },
  };
}
