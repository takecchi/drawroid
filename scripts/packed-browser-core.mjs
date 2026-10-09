// ブラウザで固めた cli を確かめる script（check-packed-browser*.mjs）が共有する道具。
import console from 'node:console';
import process from 'node:process';

import { chromium } from 'playwright-core';

/**
 * ブラウザを起動する。取得はしない: PLAYWRIGHT_CHROMIUM_PATH があればそれを、無ければ入っている Chrome（CI の ubuntu-latest にある）を、
 * それも無ければ playwright の cache にある Chromium を使う。
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchBrowser() {
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
 * ページのコンソールのエラー・例外・同じオリジンへの失敗した読み込みを集める。
 * @param {import('playwright-core').Page} page
 * @param {string} base
 * @returns {string[]} 集めたもの（呼び手が見る間も増える）
 */
export function collectProblems(page, base) {
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
  return problems;
}

/**
 * @param {boolean} ok
 * @param {string} message
 */
export function expect(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`ok: ${message}`);
}
