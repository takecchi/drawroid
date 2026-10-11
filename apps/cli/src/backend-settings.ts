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
  // 種類ごとのアダプタの作り分けは、組み立ての根（backend-factory.ts）に任せる。ここは種類を渡すだけ
  createBackend: (kind: BackendKind, options: BackendOptions) => ImageBackend;
  // 起動時に使った値。read はここから返す
  initial: {
    kind: BackendKind;
    kindSource: BackendSettingsView['kindSource'];
    url: string;
    source: BackendSettingsView['urlSource'];
    config: Config;
  };
}

export function createBackendSettings({
  configPath,
  backend,
  createBackend,
  initial,
}: BackendSettingsOptions): BackendSettingsPort {
  // 起動のときに1度だけ決める: 保存で出どころが config に替わっても、次の起動で引数が勝つことは変わらないため。出どころ（inUse）から毎回作ると、保存で false に落ちる
  const startupArgs = { kind: initial.kindSource === 'cli', url: initial.source === 'cli' };
  // config.json を読み直さず、いま使っている値を持つ: 手で書き換えた config.json の値を、繋ぎ直す前に「使っている」と見せないため
  let inUse = viewOf(
    { kind: initial.kind, source: initial.kindSource },
    { url: initial.url, source: initial.source },
    startupArgs,
    initial.config.backend,
  );

  return {
    async read() {
      return inUse;
    },
    async write({ url: chosenUrl, kind: chosen }: UpdateBackendSettings) {
      const config = await readConfig(configPath);
      // 種類や URL を省いた保存は、使っている値のままで、config.json の backend.kind / backend.url にも触れない（--backend や --backend-url で起動していると、人が触っていない値が config.json に残り、次の起動の値が変わるため）
      const kind = chosen ?? inUse.kind;
      const kindSource = chosen === undefined ? inUse.kindSource : 'config';
      const url = chosenUrl ?? inUse.url;
      const urlSource = chosenUrl === undefined ? inUse.urlSource : 'config';
      // 書く前に差し替える: 「走っていないか」の確かめと差し替えを同期で1度に行い、書いているあいだに始まった生成が古い側に残らないようにするため。走っていれば BackendBusyError で、config.json も書かない
      const previous = backend.replace(createBackend(kind, backendOptions(url, config.backend)));
      try {
        // auth・generateTimeoutMs は config.json にある値を保つ: API では変えさせない
        await writeBackendSettings(configPath, {
          ...config.backend,
          ...(chosenUrl !== undefined && { url: chosenUrl }),
          ...(chosen !== undefined && { kind: chosen }),
        });
      } catch (error) {
        try {
          backend.replace(previous);
        } catch {
          // 書けなかったあいだに新しい側で生成が始まっていれば戻せない。その生成を止められなくなるよりは、新しい側を使い続け、使っている種類と URL としてそれを見せる
          inUse = viewOf(
            { kind, source: inUse.kindSource },
            { url, source: inUse.urlSource },
            startupArgs,
            config.backend,
          );
        }
        throw error;
      }
      inUse = viewOf(
        { kind, source: kindSource },
        { url, source: urlSource },
        startupArgs,
        config.backend,
      );
      return inUse;
    },
  };
}

// パスワードを持ち出さない: 画面へ返す形には username だけを載せる
function viewOf(
  { kind, source: kindSource }: { kind: BackendKind; source: BackendSettingsView['kindSource'] },
  { url, source: urlSource }: { url: string; source: BackendSettingsView['urlSource'] },
  startupArgs: BackendSettingsView['startupArgs'],
  config: BackendConfig | undefined,
): BackendSettingsView {
  return {
    kind,
    kindSource,
    url,
    urlSource,
    startupArgs,
    auth: config?.auth === undefined ? null : { username: config.auth.username },
    generateTimeoutMs: config?.generateTimeoutMs ?? null,
  };
}
