import type {
  BackendSettingsPort,
  BackendSettingsView,
  UpdateBackendSettings,
} from '@drawroid/api';
import type { ForgeBackendOptions } from '@drawroid/backend-forge';
import type { ImageBackend } from '@drawroid/core';
import { writeBackendSettings } from '@drawroid/storage-fs';

import { readConfig, type Config } from './config.js';
import type { ReplaceableBackend } from './replaceable-backend.js';

type BackendConfig = NonNullable<Config['backend']>;

export function forgeBackendOptions(forgeUrl: string, config: BackendConfig | undefined) {
  return {
    baseUrl: forgeUrl,
    ...(config?.auth !== undefined && { auth: config.auth }),
    ...(config?.generateTimeoutMs !== undefined && {
      generateTimeoutMs: config.generateTimeoutMs,
    }),
  } satisfies ForgeBackendOptions;
}

export interface BackendSettingsOptions {
  configPath: string;
  backend: ReplaceableBackend;
  createBackend: (options: ForgeBackendOptions) => ImageBackend;
  // 起動時に使った値。read はここから返す
  initial: { forgeUrl: string; source: BackendSettingsView['forgeUrlSource']; config: Config };
}

export function createBackendSettings({
  configPath,
  backend,
  createBackend,
  initial,
}: BackendSettingsOptions): BackendSettingsPort {
  // config.json を読み直さず、いま使っている値を持つ: 手で書き換えた config.json の値を、繋ぎ直す前に「使っている」と見せないため
  let inUse = viewOf(initial.forgeUrl, initial.source, initial.config.backend);

  return {
    async read() {
      return inUse;
    },
    async write({ forgeUrl }: UpdateBackendSettings) {
      const config = await readConfig(configPath);
      // auth と generateTimeoutMs は config.json にある値を保つ: API では変えさせない
      await writeBackendSettings(configPath, { ...config.backend, forgeUrl });
      backend.replace(createBackend(forgeBackendOptions(forgeUrl, config.backend)));
      inUse = viewOf(forgeUrl, 'config', config.backend);
      return inUse;
    },
  };
}

// パスワードを持ち出さない: 画面へ返す形には username だけを載せる
function viewOf(
  forgeUrl: string,
  forgeUrlSource: BackendSettingsView['forgeUrlSource'],
  config: BackendConfig | undefined,
): BackendSettingsView {
  return {
    forgeUrl,
    forgeUrlSource,
    auth: config?.auth === undefined ? null : { username: config.auth.username },
    generateTimeoutMs: config?.generateTimeoutMs ?? null,
  };
}
