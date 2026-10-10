// build 済みの cli を起動する（ルートの `pnpm start`）。引数はそのまま cli へ渡る（例: pnpm start --port 7879）。
// 成果物が無ければ、node の英語の「Cannot find module」や、開いた画面が 500 を返す形で知るのではなく、起動の前に止める。
import console from 'node:console';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = join(repoRoot, 'apps/cli/dist/index.js');
const webIndex = join(repoRoot, 'apps/web/build/client/index.html');

const missing = [cliEntry, webIndex].filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error(
    `drawroid: build の成果物が無いので起動しない。先に pnpm build を打つ（無いもの: ${missing.join('、')}）`,
  );
  process.exit(1);
}

// 子のプロセスを立てずに読み込む: cli は process.argv.slice(2) を自分の引数として読み、SIGINT・SIGTERM も自分で受けるため
await import(pathToFileURL(cliEntry).href);
