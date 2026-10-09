#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { DEFAULT_BUDGET } from '@drawroid/core';
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
import { listen } from './listen.js';

// apps/web の成果物を dist へ写さずに、依存として解決した場所から配る: 写すと前回のビルドの古いファイルが dist に残り続けるため
function resolveWebRoot(): string {
  const webPackageJson = createRequire(import.meta.url).resolve('@drawroid/web/package.json');
  return join(dirname(webPackageJson), 'build', 'client');
}

async function main() {
  const { port, dataDir } = parseCliArgs(process.argv.slice(2));
  const root = resolveDataDir({ cliArg: dataDir, env: process.env.DRAWROID_HOME });
  const { sweptTempFiles } = await initDataDir(root);
  process.stdout.write(`drawroid: データディレクトリ ${root}\n`);
  if (sweptTempFiles.length > 0) {
    process.stdout.write(
      `drawroid: 前回の書きかけの一時ファイルを ${sweptTempFiles.length} 個片付けた\n`,
    );
  }

  const log = (line: string) => process.stdout.write(`${line}\n`);
  const store = new FsJobStore(root);
  // Forge のアダプタが入るまでバックエンドは無い
  const queue = new AutoJobQueue({
    store,
    backend: undefined,
    env: process.env,
    budget: DEFAULT_BUDGET,
    log,
  });
  const configPath = dataPaths(root).config;

  const stored = await readLlmSettings(configPath);
  if (stored === undefined) {
    log('drawroid: LLM が未設定。PUT /api/settings/llm で設定するまで、ジョブは待ち行列に留まる');
  } else {
    const parsed = llmConfigSchema.safeParse(stored);
    if (parsed.success) {
      queue.configure(parsed.data);
    } else {
      log(
        `drawroid: config.json の llm が不正なので未設定のまま進む: ${parsed.error.issues[0]?.message ?? ''}`,
      );
    }
  }
  log(
    'drawroid: 画像生成バックエンドが未設定（Forge のアダプタは M1 で入る）。それまでジョブは待ち行列に留まる',
  );
  // 落ちる前のジョブを再開する
  queue.kick();

  const llmSettings = {
    read: () => readLlmSettings(configPath),
    write: async (config: LlmConfig) => {
      await writeLlmSettings(configPath, config);
      queue.configure(config);
      queue.kick();
    },
  };
  const deps = { store, queue, budget: DEFAULT_BUDGET, llmSettings, env: process.env };
  const { address } = await listen({ port, webRoot: resolveWebRoot(), deps });
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
