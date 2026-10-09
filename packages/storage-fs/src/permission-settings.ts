import { readConfigObject, updateConfigObject } from './config-file.js';

/** config.json の permissions キー（全体の既定の許可のうち、書いたパラメータだけ）。ファイルかキーが無ければ undefined */
export async function readPermissionSettings(configPath: string): Promise<unknown | undefined> {
  return (await readConfigObject(configPath)).permissions;
}

// permissions 以外のキーを保つ: config.json には LLM やバックエンドの設定も入るため、丸ごと書き換えると消える
export async function writePermissionSettings(configPath: string, value: unknown): Promise<void> {
  await updateConfigObject(configPath, (current) => ({ ...current, permissions: value }));
}
