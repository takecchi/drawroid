// 固めた @drawroid/cli で、長い会話（数百行。長い返答と画像のカードを含む）を開き、画面の外の行の描画を飛ばしても
// （会話のログの行は content-visibility: auto）、次のことが壊れていないかをヘッドレスの Chromium で確かめる。
// 1. 末尾を追い続ける（#164）: 開くと末尾に着き、画像が読み込まれて背が伸びても、新しい行が増えても末尾に居る
// 2. ページの中の検索で、画面の外の古い発言が見つかる（window.find は Chromium のページ内検索と同じ探し方をする）
// 3. 画面の外の古い発言が、読み上げの木（CDP の Accessibility.getFullAXTree）に残っている
// 確かめが空振りしないよう、画面の外の古い行が実際に描画を飛ばされていることも見る（checkVisibility の contentVisibilityAuto）。
// 会話は、組み立てた @drawroid/storage-fs で置き場所へ直に書いてから起動する（LLM を繋がずに長い会話を作るため）。
// 前提: `pnpm build` 済み。ブラウザは取得しない（scripts/packed-browser-core.mjs）。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { collectProblems, expect, launchBrowser } from './packed-browser-core.mjs';
import { freePort, packAndInstall, repoRoot, startDrawroid } from './packed-install-core.mjs';

const STEP_TIMEOUT_MS = 30_000;
const ROWS = 300;
const OLDEST = '0 番目の頼み: いちばん古い発言';

/**
 * 長い会話を置き場所へ直に書く。人の短文・AI の短文・AI の長い Markdown・画像のカード（512px の画像4枚）を混ぜる
 * @param {string} root データディレクトリ
 * @returns {Promise<string>} 会話の ID
 */
async function seedLongConversation(root) {
  const storage = await import(join(repoRoot, 'packages/storage-fs/dist/index.js'));
  const sharp = createRequire(join(repoRoot, 'packages/storage-fs/package.json'))('sharp');
  await storage.initDataDir(root);
  const conversations = new storage.FsConversationStore(root);
  const jobs = new storage.FsJobStore(root);
  const png = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 240, g: 160, b: 80 } },
  })
    .png()
    .toBuffer();
  const job = await jobs.createJob(
    {
      kind: 'auto',
      request: '海辺の少女',
      stopConditions: { aiJudgement: false, maxIterations: 1000 },
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
  const long = Array.from(
    { length: 12 },
    (_, i) =>
      `${i} 段落目。**夕暮れの海辺**に立つ少女を、*逆光*で描きます。\n\n- 長い髪\n- 白いワンピース\n\n\`\`\`json\n{ "steps": ${i} }\n\`\`\``,
  ).join('\n\n');
  const { conversationId } = await conversations.createConversation(new Date());
  /** @param {Record<string, unknown>} event */
  const append = (event) => conversations.appendEvent(conversationId, event, new Date());
  let rows = 0;
  let turn = 0;
  let iteration = 0;
  while (rows < ROWS) {
    turn += 1;
    const text = rows === 0 ? OLDEST : `${rows} 番目の頼み: もう少し明るく`;
    const user = await append({ type: 'user.message', text, attachments: [] });
    await append({ type: 'turn.started', turn, messageSeqs: [user.seq] });
    const reply = turn % 3 === 0 ? long : `了解しました（${turn}）`;
    await append({
      type: 'assistant.message',
      turn,
      partId: `p${turn}`,
      text: reply,
      interrupted: false,
    });
    rows += 2;
    if (turn % 4 === 0) {
      iteration += 1;
      const dir = join(
        root,
        'jobs',
        job.jobId,
        'iterations',
        String(iteration).padStart(4, '0'),
        'images',
      );
      await mkdir(dir, { recursive: true });
      for (let index = 0; index < 4; index += 1) await writeFile(join(dir, `${index}.png`), png);
      await append({
        type: 'job.images',
        jobId: job.jobId,
        iteration,
        images: [0, 1, 2, 3].map((index) => ({ index, seed: index })),
      });
      rows += 1;
    }
    await append({ type: 'turn.ended', turn, outcome: 'done' });
  }
  return conversationId;
}

const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-long-'));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {import('playwright-core').Browser | undefined} */
let browser;
try {
  const bin = await packAndInstall(work);
  const dataDir = join(work, 'data');
  const conversationId = await seedLongConversation(dataDir);
  const port = await freePort();
  ({ child } = await startDrawroid(
    bin,
    ['--data-dir', dataDir, '--backend-url', 'http://127.0.0.1:1'],
    port,
  ));
  const base = `http://127.0.0.1:${port}`;

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const problems = collectProblems(page, base);
  await page.goto(`${base}/conversations/${conversationId}`);
  const log = page.getByRole('log', { name: '会話のログ' });
  await log.getByText(OLDEST).waitFor({ state: 'attached' });

  // 式は文字で渡す: この script は Node の型で検査するので、ブラウザの document を名前で書けないため
  const atEnd = `(() => { const box = document.querySelector('[role="log"]');
    return box.scrollTop + box.clientHeight >= box.scrollHeight - 4; })()`;
  await page.waitForFunction(atEnd);
  // 画像が読み込まれて背が伸びるのを待つ。そのあとも末尾に居る
  await sleep(2_000);
  expect(
    Boolean(await page.evaluate(atEnd)),
    '長い会話を開くと末尾に着き、画像が読み込まれても末尾に居る',
  );

  // 新しい行が増えても末尾を追う（LLM は繋いでいないので、ターンは失敗で閉じ、その行が足される）
  await fetch(`${base}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'いちばん新しい発言', attachments: [] }),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  await log.getByText('いちばん新しい発言').waitFor();
  await page.waitForFunction(atEnd);
  await sleep(1_000);
  expect(Boolean(await page.evaluate(atEnd)), '新しい行が増えても、末尾を追い続ける');

  // 空振りしないことの確かめ: いちばん古い行の中身は、画面の外にあって描画を飛ばされている（content-visibility を持つ行の箱そのものではなく、中身が飛ばされる）
  const oldestSkipped = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('[role="log"] > div > *')]
      .find((el) => el.textContent.includes(${JSON.stringify(OLDEST)}));
    return row !== undefined && row.firstElementChild?.checkVisibility({ contentVisibilityAuto: true }) === false;
  })()`);
  expect(Boolean(oldestSkipped), '画面の外のいちばん古い行は、描画を飛ばされている');

  const found = await page.evaluate(`window.find(${JSON.stringify(OLDEST)}, false, false, true)`);
  expect(Boolean(found), 'ページの中の検索で、画面の外のいちばん古い発言が見つかる');

  const cdp = await page.context().newCDPSession(page);
  const { nodes } = /** @type {{ nodes: { ignored?: boolean, name?: { value?: unknown } }[] }} */ (
    await cdp.send('Accessibility.getFullAXTree')
  );
  const inTree = nodes.some(
    (node) => !node.ignored && String(node.name?.value ?? '').includes(OLDEST),
  );
  expect(inTree, '画面の外のいちばん古い発言が、読み上げの木に残っている');

  expect(
    problems.length === 0,
    `コンソールのエラー・失敗した読み込みが無い${problems.length === 0 ? '' : `:\n${problems.join('\n')}`}`,
  );
} finally {
  await browser?.close();
  child?.kill();
  await rm(work, { recursive: true, force: true });
}
