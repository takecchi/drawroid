#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BUDGET, ManualGenerationRunner, permissionOverridesSchema } from '@drawroid/core';
import { llmConfigSchema, type LlmConfig } from '@drawroid/llm';
import {
  createFsMemoryStore,
  dataPaths,
  FsJobStore,
  initDataDir,
  readCandidateNotes,
  readLlmSettings,
  readPermissionSettings,
  resolveDataDir,
  writeCandidateNotes,
  writeLlmSettings,
  writePermissionSettings,
} from '@drawroid/storage-fs';

import { parseCliArgs } from './args.js';
import { AutoJobQueue, BASE_PERMISSIONS } from './auto-job-queue.js';
import { BACKEND_LABELS, backendFactory } from './backend-factory.js';
import { backendOptions, createBackendSettings } from './backend-settings.js';
import { readConfig, resolveBackendKind, resolveBackendUrlWithSource } from './config.js';
import { listen } from './listen.js';
import { ReplaceableBackend } from './replaceable-backend.js';
import { createStopConditionParser } from './stop-condition-parser.js';
import { pickWebRoot } from './web-root.js';

// tsc の出力（dist）へは apps/web の成果物を写さず、依存として解決した場所から配る: 写すと前回のビルドの古いファイルが dist に残り続けるため。
// 隣の web/ を先に見るのは配布用の bundle だけで、そちらは scripts/bundle.mjs が写す前に写し先を空にする
function resolveWebRoot(): string {
  return pickWebRoot(join(dirname(fileURLToPath(import.meta.url)), 'web'), () => {
    const webPackageJson = createRequire(import.meta.url).resolve('@drawroid/web/package.json');
    return join(dirname(webPackageJson), 'build', 'client');
  });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const root = resolveDataDir({ cliArg: args.dataDir, env: process.env.DRAWROID_HOME });
  const { sweptTempFiles } = await initDataDir(root);
  process.stdout.write(`drawroid: データディレクトリ ${root}\n`);
  if (sweptTempFiles.length > 0) {
    process.stdout.write(
      `drawroid: 前回の書きかけの一時ファイルを ${sweptTempFiles.length} 個片付けた\n`,
    );
  }

  // どのアダプタを使うかを決めるのは、組み立ての根であるここだけ
  const configPath = dataPaths(root).config;
  const config = await readConfig(configPath);
  const kind = resolveBackendKind(args.backend, config);
  const { url, source } = resolveBackendUrlWithSource(args.backendUrl, config);
  const createBackend = backendFactory(kind);
  const backend = new ReplaceableBackend(createBackend(backendOptions(url, config.backend)));
  const backendSettings = createBackendSettings({
    configPath,
    backend,
    createBackend,
    initial: { kind, url, source, config },
  });
  const store = new FsJobStore(root);
  const manualRunner = new ManualGenerationRunner({ backend, store });
  process.stdout.write(`drawroid: ${BACKEND_LABELS[kind]} ${url}\n`);

  const log = (line: string) => process.stdout.write(`${line}\n`);
  const autoQueue = new AutoJobQueue({
    store,
    backend,
    env: process.env,
    budget: DEFAULT_BUDGET,
    // 回の境目ごとに config.json を読み直す: API で変えた許可を、再起動せずに走行中のジョブの次の回から効かせるため
    permissions: async () =>
      permissionOverridesSchema.parse((await readPermissionSettings(configPath)) ?? {}),
    candidateNotes: () => readCandidateNotes(dataPaths(root).candidateNotes),
    log,
  });
  const stored = await readLlmSettings(configPath);
  if (stored === undefined) {
    log(
      'drawroid: LLM が未設定。PUT /api/settings/llm で設定するまで、自動ジョブは待ち行列に留まる',
    );
  } else {
    const parsed = llmConfigSchema.safeParse(stored);
    if (parsed.success) {
      autoQueue.configure(parsed.data);
    } else {
      log(
        `drawroid: config.json の llm が不正なので未設定のまま進む: ${parsed.error.issues[0]?.message ?? ''}`,
      );
    }
  }
  // 落ちる前の自動ジョブを再開する
  autoQueue.kick();
  const llmSettings = {
    read: () => readLlmSettings(configPath),
    write: async (llm: LlmConfig) => {
      await writeLlmSettings(configPath, llm);
      autoQueue.configure(llm);
      autoQueue.kick();
    },
  };

  const { address } = await listen({
    port: args.port,
    webRoot: resolveWebRoot(),
    deps: {
      backend,
      store,
      manualRunner,
      backendSettings,
      memoryStore: createFsMemoryStore(dataPaths(root).memory),
      autoQueue,
      budget: DEFAULT_BUDGET,
      llmSettings,
      stopConditionParser: createStopConditionParser({
        store,
        currentLlm: () => autoQueue.currentLlm(),
      }),
      permissionSettings: {
        base: BASE_PERMISSIONS,
        read: () => readPermissionSettings(configPath),
        write: (overrides) => writePermissionSettings(configPath, overrides),
      },
      candidateNotes: {
        read: () => readCandidateNotes(dataPaths(root).candidateNotes),
        write: (notes) => writeCandidateNotes(dataPaths(root).candidateNotes, notes),
      },
      env: process.env,
    },
  });
  process.stdout.write(`drawroid: http://${address.address}:${address.port}/\n`);
}

main().catch((error: unknown) => {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'EADDRINUSE') {
    process.stderr.write('drawroid: ポートが既に使われている。--port で別のポートを指定する\n');
  } else {
    process.stderr.write(`drawroid: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
