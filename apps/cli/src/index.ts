#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { ForgeBackend, type ForgeBackendOptions } from '@drawroid/backend-forge';
import { DEFAULT_BUDGET, ManualGenerationRunner } from '@drawroid/core';
import { llmConfigSchema, type LlmConfig } from '@drawroid/llm';
import {
  dataPaths,
  FsJobStore,
  initDataDir,
  readLlmSettings,
  resolveDataDir,
  writeLlmSettings,
} from '@drawroid/storage-fs';

import { parseCliArgs } from './args.js';
import { AutoJobQueue } from './auto-job-queue.js';
import { createBackendSettings, forgeBackendOptions } from './backend-settings.js';
import { readConfig, resolveForgeUrlWithSource } from './config.js';
import { listen } from './listen.js';
import { ReplaceableBackend } from './replaceable-backend.js';
import { createStopConditionParser } from './stop-condition-parser.js';

// apps/web の成果物を dist へ写さずに、依存として解決した場所から配る: 写すと前回のビルドの古いファイルが dist に残り続けるため
function resolveWebRoot(): string {
  const webPackageJson = createRequire(import.meta.url).resolve('@drawroid/web/package.json');
  return join(dirname(webPackageJson), 'build', 'client');
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
  const { forgeUrl, source } = resolveForgeUrlWithSource(args.forgeUrl, config);
  const createBackend = (options: ForgeBackendOptions) => new ForgeBackend(options);
  // 手動の生成も自動ジョブも、この入れ物を通す: どちらかが中身を直に握ると、繋ぎ直しても古い Forge を使い続け、生成中に繋ぎ直しを断る判定からも漏れるため
  const backend = new ReplaceableBackend(
    createBackend(forgeBackendOptions(forgeUrl, config.backend)),
  );
  const backendSettings = createBackendSettings({
    configPath,
    backend,
    createBackend,
    initial: { forgeUrl, source, config },
  });
  const store = new FsJobStore(root);
  const manualRunner = new ManualGenerationRunner({ backend, store });
  process.stdout.write(`drawroid: Forge ${forgeUrl}\n`);

  const log = (line: string) => process.stdout.write(`${line}\n`);
  const autoQueue = new AutoJobQueue({
    store,
    backend,
    env: process.env,
    budget: DEFAULT_BUDGET,
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
      autoQueue,
      budget: DEFAULT_BUDGET,
      llmSettings,
      stopConditionParser: createStopConditionParser({
        store,
        currentLlm: () => autoQueue.currentLlm(),
      }),
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
