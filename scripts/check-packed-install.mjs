// 固めた @drawroid/cli を空のディレクトリへ npm install し、bin から起動して `/` と `/api/health` を確かめる。
// 続けて `drawroid doctor` を、偽の Forge・偽の LLM が揃っている場合と、どちらにも繋がらない場合とで確かめる。
// 前提: `pnpm build` 済み（web の build/client が要る）。外のサービスには繋がない（偽物は 127.0.0.1 に立てる）。
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import console from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { startFakeForge } from './packed-conversation/forge.mjs';
import { startFakeLlm } from './packed-conversation/llm.mjs';
import { freePort, packAndInstall, repoRoot, startDrawroid } from './packed-install-core.mjs';

const FIXTURES = join(repoRoot, 'packages/backend-forge/src/test-support/fixtures');
// 鍵の値。doctor の出力に出てはいけない
const SECRET = 'sk-doctor-secret-value';

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
/**
 * @param {boolean} ok
 * @param {string} what
 * @param {string} output
 */
function expect(ok, what, output) {
  if (!ok) throw new Error(`${what}\n--- doctor の出力 ---\n${output}`);
  console.log(`ok   ${what}`);
}

/**
 * doctor を走らせ、出力と終了コードを返す。
 * @param {string} bin
 * @param {string} dataDir
 * @param {Record<string, unknown>} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ code: number, output: string }>}
 */
async function runDoctor(bin, dataDir, config, env) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(config));
  return new Promise((resolve) => {
    execFile(
      bin,
      ['doctor', '--data-dir', dataDir],
      { env: { ...process.env, ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

/**
 * @param {string} llmUrl
 * @param {'native' | 'json'} toolCalling
 */
function llmConfig(llmUrl, toolCalling) {
  return {
    providers: { local: { type: 'openai-compatible', baseURL: llmUrl, apiKeyEnv: 'DOCTOR_KEY' } },
    roles: { think: { provider: 'local', model: 'talk-model', toolCalling } },
  };
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {Awaited<ReturnType<typeof startFakeForge>> | undefined} */
let forge;
/** @type {Awaited<ReturnType<typeof startFakeLlm>> | undefined} */
let llm;
try {
  const bin = await packAndInstall(work);
  const port = await freePort();
  ({ child } = await startDrawroid(bin, ['--data-dir', join(work, 'data')], port));

  const base = `http://127.0.0.1:${port}`;
  await expectOk(`${base}/`, (body) => {
    if (!/<!doctype html>/i.test(body)) throw new Error('`/` が HTML を返さなかった');
  });
  await expectOk(`${base}/api/health`);
  child.kill();

  // doctor: 揃っている場合。toolCalling の2つの作り（native・json）で、話す役と1往復できる
  forge = await startFakeForge({ fixturesDir: FIXTURES, genMs: 10 });
  llm = await startFakeLlm({ stopAfterIterations: 1 });
  for (const toolCalling of /** @type {const} */ (['native', 'json'])) {
    llm.queueTalkTool('doctor_ping', {});
    const { code, output } = await runDoctor(
      bin,
      join(work, `doctor-ok-${toolCalling}`),
      { backend: { url: forge.url }, llm: llmConfig(llm.url, toolCalling) },
      { DOCTOR_KEY: SECRET },
    );
    console.log(output);
    expect(code === 0, `doctor（toolCalling: ${toolCalling}）: 揃っていれば終了コード 0`, output);
    expect(!output.includes('足りない'), '揃っていれば「足りない」が無い', output);
    for (const line of [
      '繋がる:',
      'Forge（版 ',
      'チェックポイント: 2 件',
      'サンプラ: 2 件',
      'ControlNet: モデル 2 件',
      `toolCalling: ${toolCalling}`,
      '1往復できた',
      'web の配り先',
    ]) {
      expect(output.includes(line), `揃っている場合の出力に「${line}」がある`, output);
    }
    expect(
      output.includes('DOCTOR_KEY は入っている') && !output.includes(SECRET),
      '鍵は、環境変数の名前と入っているかだけを出し、値は出さない',
      output,
    );
  }

  // doctor: 繋がらない場合。バックエンドも LLM も、誰も待ち受けていないポートを指す
  const closedBackend = `http://127.0.0.1:${await freePort()}`;
  const closedLlm = `http://127.0.0.1:${await freePort()}/v1`;
  const { code, output } = await runDoctor(
    bin,
    join(work, 'doctor-unreachable'),
    { backend: { url: closedBackend }, llm: llmConfig(closedLlm, 'native') },
    { DOCTOR_KEY: SECRET },
  );
  console.log(output);
  expect(code === 1, '繋がらなければ終了コード 1', output);
  for (const line of [
    `足りない  繋がらない: ${closedBackend}`,
    '--api を付けて起動する',
    '1往復できない',
    'LLM のサーバを起動するか',
  ]) {
    expect(output.includes(line), `繋がらない場合の出力に「${line}」がある`, output);
  }
  expect(!output.includes(SECRET), '繋がらない場合も、鍵の値は出さない', output);
} finally {
  child?.kill();
  await forge?.close();
  await llm?.close();
  await rm(work, { recursive: true, force: true });
}
