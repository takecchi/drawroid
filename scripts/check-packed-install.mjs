// 固めた @drawroid/cli を空のディレクトリへ npm install し、bin から起動して `/` と `/api/health` を確かめる。
// 前提: `pnpm build` 済み（web の build/client が要る）。
import { mkdtemp, rm } from 'node:fs/promises';
import console from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { freePort, packAndInstall, startDrawroid } from './packed-install-core.mjs';

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
  const bin = await packAndInstall(work);
  const port = await freePort();
  ({ child } = await startDrawroid(bin, ['--data-dir', join(work, 'data')], port));

  const base = `http://127.0.0.1:${port}`;
  await expectOk(`${base}/`, (body) => {
    if (!/<!doctype html>/i.test(body)) throw new Error('`/` が HTML を返さなかった');
  });
  await expectOk(`${base}/api/health`);
} finally {
  child?.kill();
  await rm(work, { recursive: true, force: true });
}
