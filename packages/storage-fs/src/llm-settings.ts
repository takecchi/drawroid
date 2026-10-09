import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from './atomic.js';

export async function readConfigObject(configPath: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} が JSON のオブジェクトではない`);
  }
  return parsed as Record<string, unknown>;
}

/** config.json の llm キー。ファイルかキーが無ければ undefined */
export async function readLlmSettings(configPath: string): Promise<unknown | undefined> {
  return (await readConfigObject(configPath)).llm;
}

// llm 以外のキーを保つ: config.json にはバックエンドの設定なども入るため、丸ごと書き換えると消える
export async function writeLlmSettings(configPath: string, value: unknown): Promise<void> {
  const current = await readConfigObject(configPath);
  await writeJsonAtomic(configPath, { ...current, llm: value });
}
