#!/usr/bin/env node
import { dataPaths, resolveDataDir } from '@drawroid/storage-fs';

import { parseCliArgs } from './args.js';
import { assembleDrawroid } from './assemble.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { describeStartupFailure } from './startup-failure.js';
import { resolveWebRoot } from './web-root.js';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const root = resolveDataDir({ cliArg: args.dataDir, env: process.env.DRAWROID_HOME });
  if (args.command === 'doctor') {
    // データディレクトリは作らない: 確かめるだけで、何も書き換えない
    const configPath = dataPaths(root).config;
    process.stdout.write(`drawroid doctor\n  データディレクトリ: ${root}\n`);
    const report = await runDoctor({
      configPath,
      backendKind: args.backend,
      backendUrl: args.backendUrl,
      caller: 'cli',
      env: process.env,
      webRoot: resolveWebRoot,
    });
    process.stdout.write(formatDoctorReport(report));
    process.exitCode = report.lacking === 0 ? 0 : 1;
    return;
  }
  const { address } = await assembleDrawroid({
    root,
    args,
    env: process.env,
    signals: process,
    exit: (code) => process.exit(code),
    write: (text) => process.stdout.write(text),
  });
  process.stdout.write(`drawroid: http://${address.address}:${address.port}/\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${describeStartupFailure(error)}\n`);
  process.exitCode = 1;
});
