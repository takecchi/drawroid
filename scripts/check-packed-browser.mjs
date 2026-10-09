// 固めた @drawroid/cli を空のディレクトリへ npm install して起動し、ヘッドレスの Chromium で Web UI を開けることを確かめる
// （M0 の受け入れ基準「ブラウザで Web UI が開ける」）。HTTP の確かめ（check-packed-install）では見えない、JS が動いて画面が描かれること・
// CSS が効いていること・コンソールにエラーが出ないことを見る。
// 前提: `pnpm build` 済み（web の build/client が要る）。
// ブラウザは取得しない: PLAYWRIGHT_CHROMIUM_PATH があればそれを、無ければ入っている Chrome（CI の ubuntu-latest にある）を、
// それも無ければ playwright の cache にある Chromium を使う。
import { mkdtemp, rm } from 'node:fs/promises';
import console from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright-core';

import { freePort, packAndInstall, startDrawroid } from './packed-install-core.mjs';

const STEP_TIMEOUT_MS = 15_000;

/** @returns {Promise<import('playwright-core').Browser>} */
async function launch() {
  const path = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (path !== undefined && path !== '') return chromium.launch({ executablePath: path });
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch (error) {
    console.log(
      `Chrome を起動できなかったので、playwright の Chromium を使う: ${String(error).split('\n')[0]}`,
    );
    return chromium.launch();
  }
}

/**
 * @param {boolean} ok
 * @param {string} message
 */
function expect(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`ok: ${message}`);
}

const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-browser-'));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {import('playwright-core').Browser | undefined} */
let browser;
try {
  const bin = await packAndInstall(work);
  const port = await freePort();
  ({ child } = await startDrawroid(bin, ['--data-dir', join(work, 'data')], port));
  const base = `http://127.0.0.1:${port}`;

  // 一覧に出るものを1つ作っておく
  const created = await fetch(`${base}/api/conversations`, {
    method: 'POST',
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (created.status !== 201) throw new Error(`会話を作れなかった: ${created.status}`);
  const { conversation } = /** @type {{ conversation: { conversationId: string } }} */ (
    await created.json()
  );

  browser = await launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  /** @type {string[]} */
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`コンソールのエラー: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`ページの例外: ${error.message}`));
  page.on('response', (response) => {
    if (response.url().startsWith(base) && response.status() >= 400) {
      problems.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(base)) problems.push(`読めなかった: ${request.url()}`);
  });

  const response = await page.goto(`${base}/`);
  expect(response?.status() === 200, '`/` が 200 を返す');

  // JS が動いて一覧が描かれた: 作った会話へのリンクが DOM に入る。見えるかは CSS しだいなので、ここでは問わない
  const link = page.locator(`a[href="/conversations/${conversation.conversationId}"]`);
  await link.waitFor({ state: 'attached' });
  expect(true, '会話の一覧に、作った会話が描かれる');

  // CSS が効いている: 背景が既定（透明・白）ではない。見えるかに頼る確かめより先に見る（CSS が無いときに、理由が名指されるように）
  // 式は文字で渡す: この script は Node の型で検査するので、ブラウザの document を名前で書けないため
  const background = String(await page.evaluate('getComputedStyle(document.body).backgroundColor'));
  expect(
    !['rgba(0, 0, 0, 0)', 'transparent', 'rgb(255, 255, 255)'].includes(background),
    `CSS が効いている（body の背景色 ${background}）`,
  );

  // 会話を1つ開く: ログと発言の入力欄が出る
  await link.click();
  await page.waitForURL(`${base}/conversations/${conversation.conversationId}`);
  await page
    .getByRole('log', { name: '会話のログ' })
    .or(page.getByLabel('会話のログ'))
    .first()
    .waitFor();
  await page.getByLabel('発言').waitFor();
  expect(true, '会話を開くと、ログと発言の入力欄が出る');

  expect(
    problems.length === 0,
    `コンソールのエラー・失敗した読み込みが無い${problems.length === 0 ? '' : `:\n${problems.join('\n')}`}`,
  );
} finally {
  await browser?.close();
  child?.kill();
  await rm(work, { recursive: true, force: true });
}
