// 固めた @drawroid/cli を空のディレクトリへ npm install し、起動する道具。check-packed-install.mjs と check-packed-conversation.mjs が共有する。
// 前提: `pnpm build` 済み（web の build/client が要る）。
import { execFile, spawn } from 'node:child_process';
import console from 'node:console';
import { mkdir, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const STARTUP_TIMEOUT_MS = 30_000;

/** @returns {Promise<number>} */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('空きポートを取れなかった');
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

/**
 * work の下に pack/・install/ を作り、固めたものを入れて bin のパスを返す。
 * @param {string} work
 * @returns {Promise<string>}
 */
export async function packAndInstall(work) {
  const packDir = join(work, 'pack');
  const installDir = join(work, 'install');
  await mkdir(packDir);
  await mkdir(installDir);

  await run('pnpm', ['--filter', '@drawroid/cli', 'pack', '--pack-destination', packDir], {
    cwd: repoRoot,
  });
  const [tgz] = await readdir(packDir);
  if (tgz === undefined) throw new Error('pnpm pack が tgz を作らなかった');
  console.log(`packed: ${tgz}`);

  await run('npm', ['install', '--no-audit', '--no-fund', join(packDir, tgz)], {
    cwd: installDir,
  });
  return join(installDir, 'node_modules', '.bin', 'drawroid');
}

/**
 * bin を起動し、待ち受けの行が出るまで待つ。
 * @param {string} bin
 * @param {string[]} args `--port` は含めない
 * @param {number} port
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, output: () => string }>}
 */
export function startDrawroid(bin, args, port, options = {}) {
  const child = spawn(bin, ['--port', String(port), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`起動が ${STARTUP_TIMEOUT_MS}ms 以内に完了しなかった`)),
      STARTUP_TIMEOUT_MS,
    );
    let output = '';
    let listening = false;
    /** @param {string} chunk */
    const onData = (chunk) => {
      output += chunk;
      if (!listening && output.includes(`:${port}/`)) {
        listening = true;
        clearTimeout(timer);
        resolve({ child, output: () => output });
      }
    };
    child.stdout?.setEncoding('utf8').on('data', onData);
    child.stderr?.setEncoding('utf8').on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!listening) reject(new Error(`起動の途中で終了した（exit ${code}）:\n${output}`));
    });
  });
}
