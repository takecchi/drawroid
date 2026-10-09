// 固めた @drawroid/cli を空のディレクトリへ npm install し、bin から起動して `/` と `/api/health` を確かめる。
// 前提: `pnpm build` 済み（web の build/client が要る）。
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import console from 'node:console';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const STARTUP_TIMEOUT_MS = 30_000;

/** @returns {Promise<number>} */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('空きポートを取れなかった');
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} port
 * @returns {Promise<void>}
 */
function waitForListening(child, port) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`起動が ${STARTUP_TIMEOUT_MS}ms 以内に完了しなかった`)),
      STARTUP_TIMEOUT_MS,
    );
    let output = '';
    /** @param {string} chunk */
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(`:${port}/`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.setEncoding('utf8').on('data', onData);
    child.stderr?.setEncoding('utf8').on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`起動の途中で終了した（exit ${code}）:\n${output}`));
    });
  });
}

/**
 * @param {string} url
 * @param {(body: string) => void} [check]
 */
async function expectOk(url, check) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  console.log(`${url} -> ${response.status} ${body.slice(0, 60).replaceAll('\n', ' ')}`);
  if (response.status !== 200) throw new Error(`${url} が ${response.status} を返した`);
  check?.(body);
}

const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-'));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
try {
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

  const port = await freePort();
  const bin = join(installDir, 'node_modules', '.bin', 'drawroid');
  child = spawn(bin, ['--port', String(port), '--data-dir', join(work, 'data')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForListening(child, port);

  const base = `http://127.0.0.1:${port}`;
  await expectOk(`${base}/`, (body) => {
    if (!/<!doctype html>/i.test(body)) throw new Error('`/` が HTML を返さなかった');
  });
  await expectOk(`${base}/api/health`);
} finally {
  child?.kill();
  await rm(work, { recursive: true, force: true });
}
