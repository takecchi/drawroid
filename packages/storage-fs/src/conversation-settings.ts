import { readConfigObject } from './config-file.js';

/** config.json の conversations キー（会話の設定。止める条件の既定など）。ファイルかキーが無ければ undefined */
export async function readConversationSettings(configPath: string): Promise<unknown | undefined> {
  return (await readConfigObject(configPath)).conversations;
}
