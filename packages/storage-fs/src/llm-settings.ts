import { readConfigObject, updateConfigObject } from './config-file.js';

/** config.json の llm キー。ファイルかキーが無ければ undefined */
export async function readLlmSettings(configPath: string): Promise<unknown | undefined> {
  return (await readConfigObject(configPath)).llm;
}

// llm 以外のキーを保つ: config.json にはバックエンドの設定なども入るため、丸ごと書き換えると消える
export async function writeLlmSettings(configPath: string, value: unknown): Promise<void> {
  await updateConfigObject(configPath, (current) => ({ ...current, llm: value }));
}
