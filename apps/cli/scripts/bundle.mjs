import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(cliRoot, 'bundle');
const webBuildDir = join(cliRoot, '..', 'web', 'build', 'client');

// cp の前に必ず空にする: 上書きで写すと、前回のビルドにだけ在った web のファイルが bundle に残り続けるため
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [join(cliRoot, 'src', 'index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // sharp だけ外に出す: ネイティブの実体（@img/sharp-*）は利用者の OS・CPU 向けに npm が選ぶもので、1ファイルへは畳めないため
  external: ['sharp'],
  // ESM の出力に require を足す: 依存の CommonJS が `require('path')` などを呼び、esbuild の代用品は ESM では「Dynamic require is not supported」で落ちるため
  banner: {
    js: "import { createRequire as createRequireForBundle } from 'node:module'; const require = createRequireForBundle(import.meta.url);",
  },
});

await cp(webBuildDir, join(outDir, 'web'), { recursive: true });
