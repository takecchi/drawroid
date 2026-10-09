import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function pickWebRoot(bundledRoot: string, resolveWorkspaceRoot: () => string): string {
  return existsSync(join(bundledRoot, 'index.html')) ? bundledRoot : resolveWorkspaceRoot();
}

// tsc の出力（dist）へは apps/web の成果物を写さず、依存として解決した場所から配る: 写すと前回のビルドの古いファイルが dist に残り続けるため。
// 隣の web/ を先に見るのは配布用の bundle だけで、そちらは scripts/bundle.mjs が写す前に写し先を空にする
export function resolveWebRoot(): string {
  return pickWebRoot(join(dirname(fileURLToPath(import.meta.url)), 'web'), () => {
    const webPackageJson = createRequire(import.meta.url).resolve('@drawroid/web/package.json');
    return join(dirname(webPackageJson), 'build', 'client');
  });
}
