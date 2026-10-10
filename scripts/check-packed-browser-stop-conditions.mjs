// 固めた @drawroid/cli で、走っているジョブの「止める条件を変える」を2つのタブで使い、手で直した欄だけが送られることを、ヘッドレスの Chromium で確かめる。
// jsdom の試験（job-operations.test.tsx）は、取り直しとイベントが届く順を本物のブラウザのとおりには再現しないため、ここでも見る。
// 1. 何も触っていない間は「条件を変える」を押せない
// 2. タブ A で枚数の上限だけを触り、タブ B で回数の上限を変える。A の回数の上限は B の値に追従し、A で送る本文は枚数の上限だけ。
//    送ったあと、両方のタブの「いまの条件」に、B が変えた回数と A が変えた枚数が並ぶ（B の変更を A の古い値で戻さない）
// 3. タブ A で回数の上限を消して送ると、本文はその欄の null だけで、両方のタブの「いまの条件」から回数の上限が消える
// 偽の LLM と偽の Forge は check-packed-conversation の部品（scripts/packed-conversation/）を使う。ジョブは回を重ね続けるようにして、確かめの間は止めない。
// 前提: `pnpm build` 済み。ブラウザは取得しない（scripts/packed-browser-core.mjs）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { collectProblems, expect, launchBrowser } from './packed-browser-core.mjs';
import { startFakeForge } from './packed-conversation/forge.mjs';
import { startFakeLlm } from './packed-conversation/llm.mjs';
import { freePort, packAndInstall, repoRoot, startDrawroid } from './packed-install-core.mjs';

const STEP_TIMEOUT_MS = 30_000;
const FIXTURES = join(repoRoot, 'packages/backend-forge/src/test-support/fixtures');
// ジョブを確かめの間じゅう走らせておく: 見る役はこの回まで「止めてよい」と言わず、上限もこれより大きくする
const ITERATIONS = 200;

/**
 * @param {string} base
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function api(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${method} ${path} が ${response.status}: ${text}`);
  return text === '' ? undefined : JSON.parse(text);
}

/**
 * 「条件を変える」を押し、そのとき送った口出しの本文を返す
 * @param {import('playwright-core').Page} page
 * @param {string} jobId
 */
async function sendChange(page, jobId) {
  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith(`/api/jobs/auto/${jobId}/interventions`),
    ),
    page.getByRole('button', { name: '条件を変える' }).click(),
  ]);
  return request.postDataJSON();
}

/**
 * 「いまの条件」の並び（次の回の境目から効く）
 * @param {import('playwright-core').Page} page
 */
async function currentLines(page) {
  const list = page
    .getByText('いまの条件（次の回の境目から効く）')
    .locator('xpath=following-sibling::ul');
  return (await list.locator('li').allTextContents()).map((line) => line.trim());
}

/**
 * 「いまの条件」が lines になるまで待つ（取り直しはポーリングで届く）
 * @param {import('playwright-core').Page} page
 * @param {string[]} lines
 * @param {string} label
 */
async function waitForCurrent(page, lines, label) {
  const until = Date.now() + STEP_TIMEOUT_MS;
  let seen = await currentLines(page);
  while (JSON.stringify(seen) !== JSON.stringify(lines)) {
    if (Date.now() > until) {
      throw new Error(
        `${label}: 「いまの条件」が ${JSON.stringify(lines)} にならない（${JSON.stringify(seen)}）`,
      );
    }
    await page.waitForTimeout(100);
    seen = await currentLines(page);
  }
  return seen;
}

const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-stop-'));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {import('playwright-core').Browser | undefined} */
let browser;
/** @type {Awaited<ReturnType<typeof startFakeForge>> | undefined} */
let forge;
/** @type {Awaited<ReturnType<typeof startFakeLlm>> | undefined} */
let llm;
try {
  const bin = await packAndInstall(work);
  forge = await startFakeForge({ fixturesDir: FIXTURES, genMs: 500 });
  llm = await startFakeLlm({ stopAfterIterations: ITERATIONS });
  const port = await freePort();
  ({ child } = await startDrawroid(
    bin,
    ['--data-dir', join(work, 'data'), '--backend-url', forge.url],
    port,
  ));
  const base = `http://127.0.0.1:${port}`;
  /** @param {string} model */
  const role = (model) => ({
    provider: 'fake',
    model,
    structuredOutput: 'native',
    reasoning: 'native',
    toolCalling: 'native',
    imageInput: true,
  });
  await api(base, 'PUT', '/api/settings/llm', {
    providers: { fake: { type: 'openai-compatible', baseURL: llm.url } },
    roles: { think: role('think-model'), judge: role('judge-model'), talk: role('talk-model') },
    validationRetries: 1,
    networkRetries: 0,
  });
  const { jobId } = await api(base, 'POST', '/api/jobs/auto', {
    request: '夕焼けの海辺の少女',
    stopConditions: { aiJudgement: true, maxIterations: 500 },
  });
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const a = await context.newPage();
  const b = await context.newPage();
  const problems = [];
  for (const page of [a, b]) {
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    problems.push(collectProblems(page, base));
    await page.goto(`${base}/jobs/${jobId}`);
    await page.getByRole('button', { name: '条件を変える' }).waitFor();
  }

  // 1. 何も触っていない間は押せない
  expect(
    (await a.getByRole('button', { name: '条件を変える' }).isDisabled()) &&
      (await b.getByRole('button', { name: '条件を変える' }).isDisabled()),
    '何も触っていない間は、どちらのタブでも「条件を変える」を押せない',
  );

  // 2. A で枚数の上限だけを触り、B で回数の上限を変える
  await a.getByLabel(/枚数の上限/).fill('300');
  await b.getByLabel(/回数の上限/).fill('400');
  const sentByB = await sendChange(b, jobId);
  expect(
    JSON.stringify(sentByB) ===
      JSON.stringify({ kind: 'stopConditions', stopConditions: { maxIterations: 400 } }),
    `タブ B は、触った回数の上限だけを送る（${JSON.stringify(sentByB)}）`,
  );
  // A の回数の上限は、B の変更に追従し（取り直しはポーリングで届く）、A が触った枚数の上限はそのまま残る
  const iterationsInA = a.getByLabel(/回数の上限/);
  const followUntil = Date.now() + STEP_TIMEOUT_MS;
  while ((await iterationsInA.inputValue()) !== '400') {
    if (Date.now() > followUntil) {
      throw new Error(
        `タブ A の回数の上限が、タブ B の変更（400）に追従しない（${await iterationsInA.inputValue()}）`,
      );
    }
    await a.waitForTimeout(100);
  }
  expect(
    (await a.getByLabel(/枚数の上限/).inputValue()) === '300',
    'タブ A の回数の上限はタブ B の変更（400）に追従し、手で直した枚数の上限（300）はそのまま残る',
  );
  const sentByA = await sendChange(a, jobId);
  expect(
    JSON.stringify(sentByA) ===
      JSON.stringify({ kind: 'stopConditions', stopConditions: { maxImages: 300 } }),
    `タブ A は、手で直した枚数の上限だけを送り、タブ B が変えた回数の上限を送らない（${JSON.stringify(sentByA)}）`,
  );
  const both = ['AI が意図どおりと判断したら', '400 回まで', '300 枚まで'];
  await waitForCurrent(a, both, 'タブ A');
  await waitForCurrent(b, both, 'タブ B');
  const { current: afterBoth } = await api(base, 'GET', `/api/jobs/auto/${jobId}/stop-conditions`);
  expect(
    JSON.stringify(afterBoth) ===
      JSON.stringify({ aiJudgement: true, maxIterations: 400, maxImages: 300 }),
    `両方のタブの「いまの条件」と API の今の条件に、B が変えた 400 回と A が変えた 300 枚が並ぶ（${JSON.stringify(afterBoth)}）`,
  );
  expect(
    (await a.getByRole('button', { name: '条件を変える' }).isDisabled()) &&
      (await b.getByRole('button', { name: '条件を変える' }).isDisabled()),
    '送ったあとは、どちらのタブも直した欄が無くなり、「条件を変える」を押せない',
  );

  // 3. A で回数の上限を消して送る
  await a.getByLabel(/回数の上限/).fill('');
  const cleared = await sendChange(a, jobId);
  expect(
    JSON.stringify(cleared) ===
      JSON.stringify({ kind: 'stopConditions', stopConditions: { maxIterations: null } }),
    `回数の上限を消して送ると、本文はその欄の null だけ（${JSON.stringify(cleared)}）`,
  );
  const withoutIterations = ['AI が意図どおりと判断したら', '300 枚まで'];
  await waitForCurrent(a, withoutIterations, 'タブ A');
  await waitForCurrent(b, withoutIterations, 'タブ B');
  expect(
    (await b.getByLabel(/回数の上限/).inputValue()) === '',
    '回数の上限を消すと、両方のタブの「いまの条件」から回数の上限が消え、タブ B の欄も空になる',
  );

  const all = problems.flat();
  expect(
    all.length === 0,
    `コンソールのエラー・失敗した読み込みが無い${all.length === 0 ? '' : `:\n${all.join('\n')}`}`,
  );
} finally {
  await browser?.close();
  child?.kill();
  await forge?.close();
  await llm?.close();
  await rm(work, { recursive: true, force: true });
}
