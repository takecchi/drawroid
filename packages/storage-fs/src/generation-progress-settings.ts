import { readConfigObject, updateConfigObject } from './config-file.js';

/** config.json の generationProgress キー。ファイルかキーが無ければ undefined */
export async function readGenerationProgressSettings(
  configPath: string,
): Promise<unknown | undefined> {
  return (await readConfigObject(configPath)).generationProgress;
}

// generationProgress 以外のキーを保つ: config.json には LLM やバックエンド・予算の設定も入るため、丸ごと書き換えると消える
export async function writeGenerationProgressSettings(
  configPath: string,
  settings: unknown,
): Promise<void> {
  await updateConfigObject(configPath, (current) => ({ ...current, generationProgress: settings }));
}
