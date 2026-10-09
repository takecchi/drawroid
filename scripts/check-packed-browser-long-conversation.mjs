// 固めた @drawroid/cli で会話のログを開き、画面の外の行の描画を飛ばす手当て（行の数が SKIP_OFFSCREEN_AFTER_ROWS を超えた会話だけ
// content-visibility: auto）が、次のことを壊していないかをヘッドレスの Chromium で確かめる。
// 長い会話（線より長い）:
// 1. 末尾を追い続ける（#164）: 開くと末尾に着き、画像が読み込まれて背が伸びても、新しい行が増えても末尾に居る
// 2. ページの中の検索で、画面の外の古い発言が見つかる（window.find は Chromium のページ内検索と同じ探し方をする）
// 3. 画面の外の古い発言が、読み上げの木（CDP の Accessibility.getFullAXTree）に残っている
// 確かめが空振りしないよう、画面の外の古い行が実際に描画を飛ばされていることも見る（checkVisibility の contentVisibilityAuto）。
// 短い会話（線より短い）: 画面の外の行も描画を飛ばさない（速いスクロールを重くしないため）。
// 途中で線を越える会話: 上を読んでいる間に越えても、読んでいる行がずれない（飛ばし始めるのは末尾へ戻ってから）。
// 末尾へ戻ったあとは描画を飛ばし、末尾も追い続ける。
// 会話は、組み立てた @drawroid/storage-fs で置き場所へ直に書いてから起動する（LLM を繋がずに長い会話を作るため）。
// 前提: `pnpm build` 済み。ブラウザは取得しない（scripts/packed-browser-core.mjs）。
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import console from 'node:console';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { collectProblems, expect, launchBrowser } from './packed-browser-core.mjs';
import { startFakeForge } from './packed-conversation/forge.mjs';
import { freePort, packAndInstall, repoRoot, startDrawroid } from './packed-install-core.mjs';

const STEP_TIMEOUT_MS = 30_000;
// 途中で線を越える会話で、画像の応答を遅らせる長さ。開いてから上へ戻すまで（末尾に着いて 1.5 秒）より長くする
const IMAGE_DELAY_MS = 3_000;
const FIXTURES = join(repoRoot, 'packages/backend-forge/src/test-support/fixtures');

// 線の値は ui の正本から読む（ここへ写すと、線を動かしたときに確かめだけが古い線のまま残るため）
const logSource = await readFile(
  join(repoRoot, 'packages/ui/src/components/features/chat/log.tsx'),
  'utf8',
);
const threshold = Number(
  /SKIP_OFFSCREEN_AFTER_ROWS = ([\d_]+);/.exec(logSource)?.[1]?.replaceAll('_', '') ?? NaN,
);
if (!Number.isInteger(threshold) || threshold < 1) {
  throw new Error('SKIP_OFFSCREEN_AFTER_ROWS を log.tsx から読めなかった');
}

/**
 * 会話を置き場所へ直に書く。人の短文・AI の短文・AI の長い Markdown・画像のカード（512px の画像4枚）を混ぜる。
 * 行の数は画面の行（ChatItem）の数で、人の発言・AI の返答・画像のカードが1行ずつ。
 * @param {any} storage 組み立てた @drawroid/storage-fs
 * @param {string} root データディレクトリ
 * @param {{ jobId: string, png: Buffer }} job 画像のカードが指すジョブ
 * @param {number} rows 行の数（ちょうどにする）
 * @param {string} oldest いちばん古い発言の本文
 * @returns {Promise<string>} 会話の ID
 */
async function seedConversation(storage, root, job, rows, oldest) {
  const conversations = new storage.FsConversationStore(root);
  const long = Array.from(
    { length: 12 },
    (_, i) =>
      `${i} 段落目。**夕暮れの海辺**に立つ少女を、*逆光*で描きます。\n\n- 長い髪\n- 白いワンピース\n\n\`\`\`json\n{ "steps": ${i} }\n\`\`\``,
  ).join('\n\n');
  const { conversationId } = await conversations.createConversation(new Date());
  /** @param {Record<string, unknown>} event */
  const append = (event) => conversations.appendEvent(conversationId, event, new Date());
  let written = 0;
  let turn = 0;
  while (written < rows) {
    turn += 1;
    const text = written === 0 ? oldest : `${written} 番目の頼み: もう少し明るく`;
    const user = await append({ type: 'user.message', text, attachments: [] });
    written += 1;
    if (written === rows) break;
    await append({ type: 'turn.started', turn, messageSeqs: [user.seq] });
    const reply = turn % 3 === 0 ? long : `了解しました（${turn}）`;
    await append({
      type: 'assistant.message',
      turn,
      partId: `p${turn}`,
      text: reply,
      interrupted: false,
    });
    written += 1;
    if (turn % 4 === 0 && written < rows) {
      const iteration = await nextIteration(root, job);
      await append({
        type: 'job.images',
        jobId: job.jobId,
        iteration,
        images: [0, 1, 2, 3].map((index) => ({ index, seed: index })),
        // 本物の記録と同じく、頼んだ大きさを書く（画面は読み込む前から、この縦横の比で画像の背を取る）
        size: { width: 512, height: 512 },
      });
      written += 1;
    }
    await append({ type: 'turn.ended', turn, outcome: 'done' });
  }
  return conversationId;
}

let iterations = 0;
/**
 * ジョブに回を1つ足し、画像4枚を置く
 * @param {string} root
 * @param {{ jobId: string, png: Buffer }} job
 */
async function nextIteration(root, job) {
  iterations += 1;
  const dir = join(
    root,
    'jobs',
    job.jobId,
    'iterations',
    String(iterations).padStart(4, '0'),
    'images',
  );
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < 4; index += 1) await writeFile(join(dir, `${index}.png`), job.png);
  return iterations;
}

/** @param {string} root */
async function seedAll(root) {
  const storage = await import(join(repoRoot, 'packages/storage-fs/dist/index.js'));
  const sharp = createRequire(join(repoRoot, 'packages/storage-fs/package.json'))('sharp');
  await storage.initDataDir(root);
  const png = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 240, g: 160, b: 80 } },
  })
    .png()
    .toBuffer();
  const created = await new storage.FsJobStore(root).createJob(
    {
      kind: 'auto',
      request: '海辺の少女',
      stopConditions: { aiJudgement: false, maxIterations: 100_000 },
      batchSize: 4,
    },
    {
      status: 'stopped',
      carry: { intent: '海辺の少女', completedIterations: 0 },
      stoppedAt: new Date().toISOString(),
      imagesGenerated: 0,
      reason: { kind: 'human', detail: '確かめのため' },
    },
    new Date(),
  );
  const job = { jobId: created.jobId, png };
  return {
    long: await seedConversation(storage, root, job, threshold + 100, OLDEST.long),
    // 画面より長いが、線より短い会話（いちばん古い行が画面の外に出る長さ）
    short: await seedConversation(storage, root, job, Math.min(40, threshold - 1), OLDEST.short),
    // あと1行で線を越える会話（発言を1つ送ると、人の行と失敗の行の2行が足されて越える）
    crossing: await seedConversation(storage, root, job, threshold, OLDEST.crossing),
  };
}

const OLDEST = {
  long: '長い会話の、いちばん古い発言',
  short: '短い会話の、いちばん古い発言',
  crossing: '途中で線を越える会話の、いちばん古い発言',
};

// 式は文字で渡す: この script は Node の型で検査するので、ブラウザの document を名前で書けないため
const AT_END = `(() => { const box = document.querySelector('[role="log"]');
  return box.scrollTop + box.clientHeight >= box.scrollHeight - 4; })()`;

// 末尾に着かなかったときに、何を見ていたかを残す: CI でだけ落ちる揺れを、ログだけで見分けるため
const LOG_STATE = `(() => { const box = document.querySelector('[role="log"]');
  if (box === null) return 'ログが無い';
  const rows = box.firstElementChild === null ? [] : [...box.firstElementChild.children];
  const last = rows.at(-1);
  return JSON.stringify({
    scrollTop: Math.round(box.scrollTop),
    clientHeight: box.clientHeight,
    scrollHeight: box.scrollHeight,
    fromEnd: Math.round(box.scrollHeight - box.clientHeight - box.scrollTop),
    rows: rows.length,
    lastRow: last === undefined ? null : last.textContent.slice(0, 80),
  }); })()`;

/**
 * 末尾に着くのを待つ。着かなければ、ログの状態（スクロール位置・背・行数・末尾の行）を添えて落とす
 * @param {import('playwright-core').Page} page
 * @param {string} where どの段で待っていたか
 */
async function waitAtEnd(page, where) {
  try {
    await page.waitForFunction(AT_END);
  } catch (error) {
    const state = await page.evaluate(LOG_STATE).catch(() => '読めない');
    throw new Error(`${where}: 末尾に着かなかった。ログの状態: ${String(state)}`, { cause: error });
  }
}

/**
 * 末尾に居ることを確かめる。居なければ、ログの状態を添えて落とす
 * @param {import('playwright-core').Page} page
 * @param {string} message
 */
async function expectAtEnd(page, message) {
  if (await page.evaluate(AT_END)) {
    expect(true, message);
    return;
  }
  expect(false, `${message}。ログの状態: ${String(await page.evaluate(LOG_STATE))}`);
}

/** @param {string} text いちばん古い行が描画を飛ばされているか（行の箱ではなく、中身が飛ばされる） */
const oldestSkipped = (text) => `(() => {
  const row = [...document.querySelectorAll('[role="log"] > div > *')]
    .find((el) => el.textContent.includes(${JSON.stringify(text)}));
  if (row === undefined) return null;
  return row.firstElementChild?.checkVisibility({ contentVisibilityAuto: true }) === false;
})()`;

const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-long-'));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {import('playwright-core').Browser | undefined} */
let browser;
/** @type {Awaited<ReturnType<typeof startFakeForge>> | undefined} */
let forge;
try {
  const bin = await packAndInstall(work);
  const dataDir = join(work, 'data');
  const ids = await seedAll(dataDir);
  // 偽の Forge に繋ぐ: 画面はバックエンドの状態を読むので、繋がらない先だと 502 がコンソールに出て、壊れていないかの確かめと混ざるため
  forge = await startFakeForge({ fixturesDir: FIXTURES, genMs: 0 });
  const port = await freePort();
  ({ child } = await startDrawroid(bin, ['--data-dir', dataDir, '--backend-url', forge.url], port));
  const base = `http://127.0.0.1:${port}`;
  /** @param {string} conversationId @param {string} text */
  const say = (conversationId, text) =>
    fetch(`${base}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, attachments: [] }),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const problems = collectProblems(page, base);
  const log = page.getByRole('log', { name: '会話のログ' });
  console.log(`線（SKIP_OFFSCREEN_AFTER_ROWS）: ${threshold} 行`);

  // --- 長い会話 ---
  await page.goto(`${base}/conversations/${ids.long}`);
  await log.getByText(OLDEST.long).waitFor({ state: 'attached' });
  await waitAtEnd(page, '長い会話を開いたあと');
  // 画像が読み込まれて背が伸びるのを待つ。そのあとも末尾に居る
  await sleep(2_000);
  await expectAtEnd(page, '長い会話を開くと末尾に着き、画像が読み込まれても末尾に居る');
  // 新しい行が増えても末尾を追う（LLM は繋いでいないので、ターンは失敗で閉じ、その行が足される）
  await say(ids.long, '長い会話の、いちばん新しい発言');
  await log.getByText('長い会話の、いちばん新しい発言').waitFor();
  await waitAtEnd(page, '長い会話に新しい行が増えたあと');
  await sleep(1_000);
  await expectAtEnd(page, '新しい行が増えても、末尾を追い続ける');
  expect(
    (await page.evaluate(oldestSkipped(OLDEST.long))) === true,
    '長い会話では、画面の外のいちばん古い行の描画を飛ばしている',
  );
  const found = await page.evaluate(
    `window.find(${JSON.stringify(OLDEST.long)}, false, false, true)`,
  );
  expect(Boolean(found), 'ページの中の検索で、画面の外のいちばん古い発言が見つかる');
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = /** @type {{ nodes: { ignored?: boolean, name?: { value?: unknown } }[] }} */ (
    await cdp.send('Accessibility.getFullAXTree')
  );
  expect(
    nodes.some((node) => !node.ignored && String(node.name?.value ?? '').includes(OLDEST.long)),
    '画面の外のいちばん古い発言が、読み上げの木に残っている',
  );

  // --- 短い会話 ---
  await page.goto(`${base}/conversations/${ids.short}`);
  await log.getByText(OLDEST.short).waitFor({ state: 'attached' });
  await waitAtEnd(page, '短い会話を開いたあと');
  const shortOutside = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('[role="log"] > div > *')]
      .find((el) => el.textContent.includes(${JSON.stringify(OLDEST.short)}));
    const box = document.querySelector('[role="log"]').getBoundingClientRect();
    return row !== undefined && row.getBoundingClientRect().bottom < box.top;
  })()`);
  expect(Boolean(shortOutside), '短い会話でも、いちばん古い行は画面の外にある（確かめの前提）');
  expect(
    (await page.evaluate(oldestSkipped(OLDEST.short))) === false,
    '線より短い会話では、画面の外の行も描画を飛ばさない',
  );

  // --- 途中で線を越える会話 ---
  // 画像の読み込みを遅らせる: 上へ戻したあとに上の画像が読み込まれても、読んでいる行がずれないことも縛るため
  // （画像が背を取っていないと、読み込まれた画像の背のぶん行が押し下げられる。CI の遅い機械ではこれで揺れていた）
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'image') await sleep(IMAGE_DELAY_MS);
    await route.continue();
  });
  await page.goto(`${base}/conversations/${ids.crossing}`);
  await log.getByText(OLDEST.crossing).waitFor({ state: 'attached' });
  await waitAtEnd(page, '途中で線を越える会話を開いたあと');
  await sleep(1_500);
  expect(
    (await page.evaluate(oldestSkipped(OLDEST.crossing))) === false,
    '線を越える前は、描画を飛ばさない',
  );
  // 上を読んでいる（末尾を追っていない）間に、線を越える。読んでいる行（画面の真ん中の行）が動かないこと
  const reading = await page.evaluate(`(async () => {
    const box = document.querySelector('[role="log"]');
    box.scrollTop = Math.max(0, box.scrollTop - box.clientHeight * 5);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rect = box.getBoundingClientRect();
    let el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    while (el && el.parentElement !== box.firstElementChild) el = el.parentElement;
    window.__readingRow = el;
    return el ? el.getBoundingClientRect().top : null;
  })()`);
  expect(typeof reading === 'number', '上を読んでいる行を1つ選べる（確かめの前提）');
  await say(ids.crossing, '線を越える発言');
  await log.getByText('線を越える発言').waitFor({ state: 'attached' });
  await sleep(1_500);
  const moved = Number(
    await page.evaluate(
      `Math.abs(window.__readingRow.getBoundingClientRect().top - ${String(reading)})`,
    ),
  );
  expect(moved < 4, `上を読んでいる間に線を越えても、読んでいる行がずれない（${moved}px）`);
  expect(
    (await page.evaluate(oldestSkipped(OLDEST.crossing))) === false,
    '上を読んでいる間は、線を越えても描画を飛ばし始めない',
  );
  // 末尾へ戻し、行が増えると、描画を飛ばし始め、末尾も追い続ける
  await page.evaluate(`(() => { const box = document.querySelector('[role="log"]');
    box.scrollTop = box.scrollHeight; })()`);
  await waitAtEnd(page, '末尾へ戻したあと');
  await say(ids.crossing, '越えたあとの発言');
  await log.getByText('越えたあとの発言').waitFor();
  await waitAtEnd(page, '線を越えたあとに行が増えたあと');
  await sleep(1_000);
  await expectAtEnd(page, '線を越えたあとも、末尾を追い続ける');
  expect(
    (await page.evaluate(oldestSkipped(OLDEST.crossing))) === true,
    '末尾へ戻ったあとは、画面の外の行の描画を飛ばす',
  );

  expect(
    problems.length === 0,
    `コンソールのエラー・失敗した読み込みが無い${problems.length === 0 ? '' : `:\n${problems.join('\n')}`}`,
  );
} finally {
  await browser?.close();
  child?.kill();
  await forge?.close();
  await rm(work, { recursive: true, force: true });
}
