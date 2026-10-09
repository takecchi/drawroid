import { writeJsonAtomic } from './atomic.js';
import { readConfigObject } from './config-file.js';

/** config.json の backend キー。ファイルかキーが無ければ undefined */
export async function readBackendSettings(configPath: string): Promise<unknown | undefined> {
  return (await readConfigObject(configPath)).backend;
}

// backend 以外のキーを保つ: config.json には LLM の設定なども入るため、丸ごと書き換えると消える
export async function writeBackendSettings(configPath: string, value: unknown): Promise<void> {
  const current = await readConfigObject(configPath);
  await writeJsonAtomic(configPath, { ...current, backend: value });
}
