import type {
  BackendKind,
  BackendSettingsPort,
  BackendSettingsView,
  UpdateBackendSettings,
} from '@drawroid/api';
import type { ImageBackend } from '@drawroid/core';
import { writeBackendSettings } from '@drawroid/storage-fs';

import { readConfig, type Config } from './config.js';
import type { ReplaceableBackend } from './replaceable-backend.js';

type BackendConfig = NonNullable<Config['backend']>;

/** Forge と A1111 のアダプタが共通に受け取る接続の値 */
export interface BackendOptions {
  baseUrl: string;
  auth?: { username: string; password: string };
  generateTimeoutMs?: number;
}

export function backendOptions(url: string, config: BackendConfig | undefined): BackendOptions {
  return {
    baseUrl: url,
    ...(config?.auth !== undefined && { auth: config.auth }),
    ...(config?.generateTimeoutMs !== undefined && {
      generateTimeoutMs: config.generateTimeoutMs,
    }),
  };
}

export interface BackendSettingsOptions {
  configPath: string;
  backend: ReplaceableBackend;
  // 種類は起動時に決めたものに固定する: 繋ぎ直しで変えるのは URL だけ
  createBackend: (options: BackendOptions) => ImageBackend;
  // 起動時に使った値。read はここから返す
  initial: {
    kind: BackendKind;
    forgeUrl: string;
    source: BackendSettingsView['forgeUrlSource'];
    config: Config;
  };
}

export function createBackendSettings({
  configPath,
  backend,
  createBackend,
  initial,
}: BackendSettingsOptions): BackendSettingsPort {
  const { kind } = initial;
  // config.json を読み直さず、いま使っている値を持つ: 手で書き換えた config.json の値を、繋ぎ直す前に「使っている」と見せないため
  let inUse = viewOf(kind, initial.forgeUrl, initial.source, initial.config.backend);

  return {
    async read() {
      return inUse;
    },
    async write({ forgeUrl }: UpdateBackendSettings) {
      const config = await readConfig(configPath);
      // 書く前に差し替える: 「走っていないか」の確かめと差し替えを同期で1度に行い、書いているあいだに始まった生成が古い側に残らないようにするため。走っていれば BackendBusyError で、config.json も書かない
      const previous = backend.replace(createBackend(backendOptions(forgeUrl, config.backend)));
      try {
        // 種類・auth・generateTimeoutMs は config.json にある値を保つ: API では変えさせない
        await writeBackendSettings(configPath, { ...config.backend, forgeUrl });
      } catch (error) {
        try {
          backend.replace(previous);
        } catch {
          // 書けなかったあいだに新しい側で生成が始まっていれば戻せない。その生成を止められなくなるよりは、新しい側を使い続け、使っている URL としてそれを見せる
          inUse = viewOf(kind, forgeUrl, inUse.forgeUrlSource, config.backend);
        }
        throw error;
      }
      inUse = viewOf(kind, forgeUrl, 'config', config.backend);
      return inUse;
    },
  };
}

// パスワードを持ち出さない: 画面へ返す形には username だけを載せる
function viewOf(
  kind: BackendKind,
  forgeUrl: string,
  forgeUrlSource: BackendSettingsView['forgeUrlSource'],
  config: BackendConfig | undefined,
): BackendSettingsView {
  return {
    kind,
    forgeUrl,
    forgeUrlSource,
    auth: config?.auth === undefined ? null : { username: config.auth.username },
    generateTimeoutMs: config?.generateTimeoutMs ?? null,
  };
}
