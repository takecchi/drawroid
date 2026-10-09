import type { LlmSettingsStore } from '@drawroid/api';
import type { LlmConfig } from '@drawroid/llm';
import { readLlmSettings, writeLlmSettings } from '@drawroid/storage-fs';

export const LLM_SETTINGS_LOADED = 'drawroid: LLM の設定を読み込んだ';

/**
 * config.json の llm を読み書きする口。書いたら、その設定を効かせてから待ち行列を動かす。
 */
// 書いたことをログに残す: 起動時の「LLM が未設定」の行が出たままになり、設定が効いたのかが端末から分からないため
export function createLlmSettings(deps: {
  configPath: string;
  configure: (llm: LlmConfig) => Promise<void>;
  kick: () => void;
  log: (line: string) => void;
}): LlmSettingsStore {
  return {
    read: () => readLlmSettings(deps.configPath),
    write: async (llm) => {
      await writeLlmSettings(deps.configPath, llm);
      await deps.configure(llm);
      deps.log(LLM_SETTINGS_LOADED);
      deps.kick();
    },
  };
}
