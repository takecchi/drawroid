#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { parseCliArgs } from './args.js';
import { listen } from './listen.js';

// apps/web の成果物を dist へ写さずに、依存として解決した場所から配る: 写すと前回のビルドの古いファイルが dist に残り続けるため
function resolveWebRoot(): string {
  const webPackageJson = createRequire(import.meta.url).resolve('@drawroid/web/package.json');
  return join(dirname(webPackageJson), 'build', 'client');
}

async function main() {
  const { port } = parseCliArgs(process.argv.slice(2));
  const { address } = await listen({ port, webRoot: resolveWebRoot() });
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
