// 固めた @drawroid/cli で、会話の画像を大きく見る窓（ImageViewer）が、ヘッドレスの Chromium で次のとおり動くかを確かめる。
// 1. 縮小版は「大きく見る: N 回目の画像 M 番」という名前のボタンで、押すと、その画像の名前の窓が開く
// 2. 左右のキーで、同じ回の隣の画像へ、端まで来たら次の回の画像へ送る
// 3. Esc で閉じ、焦点は最後に見ていた画像の縮小版へ戻る
// 4. 狭い画面（390×844）でも、窓と画像が画面の中に収まり、横にはみ出さない。横へなぞると次の画像へ送る
// 5. ジョブの詳細の画像も、同じ窓で大きく見られる
// 会話は、組み立てた @drawroid/storage-fs で置き場所へ直に書いてから起動する（画像を生成せずに画像の行を作るため）。
// 前提: `pnpm build` 済み。ブラウザは取得しない（scripts/packed-browser-core.mjs）。
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { collectProblems, expect, launchBrowser } from './packed-browser-core.mjs';
import { startFakeForge } from './packed-conversation/forge.mjs';
import { freePort, packAndInstall, repoRoot, startDrawroid } from './packed-install-core.mjs';

const STEP_TIMEOUT_MS = 30_000;
const FIXTURES = join(repoRoot, 'packages/backend-forge/src/test-support/fixtures');
const ITERATIONS = 2;
const PER_ITERATION = 4;

/**
 * 画像の行が2回ぶんある会話を置き場所へ直に書く（回ごとに 512px の画像4枚。回ごとに色を変える）
 * @param {string} root データディレクトリ
 * @returns {Promise<{ conversationId: string, jobId: string }>}
 */
async function seed(root) {
  const storage = await import(join(repoRoot, 'packages/storage-fs/dist/index.js'));
  const sharp = createRequire(join(repoRoot, 'packages/storage-fs/package.json'))('sharp');
  await storage.initDataDir(root);
  const job = await new storage.FsJobStore(root).createJob(
    {
      kind: 'auto',
      request: '海辺の少女',
      stopConditions: { aiJudgement: false, maxIterations: 10 },
      batchSize: PER_ITERATION,
    },
    {
      status: 'stopped',
      carry: { intent: '海辺の少女', completedIterations: ITERATIONS },
      stoppedAt: new Date().toISOString(),
      imagesGenerated: ITERATIONS * PER_ITERATION,
      reason: { kind: 'human', detail: '確かめのため' },
    },
    new Date(),
  );
  const conversations = new storage.FsConversationStore(root);
  const { conversationId } = await conversations.createConversation(new Date());
  /** @param {Record<string, unknown>} event */
  const append = (event) => conversations.appendEvent(conversationId, event, new Date());
  await append({ type: 'user.message', text: '海辺の少女を描いて', attachments: [] });
  const jobs = new storage.FsJobStore(root);
  for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    const images = [];
    for (let index = 0; index < PER_ITERATION; index += 1) {
      const png = await sharp({
        create: {
          width: 512,
          height: 512,
          channels: 3,
          background: { r: 60 * index, g: 120, b: 100 * iteration },
        },
      })
        .png()
        .toBuffer();
      images.push({ png, seed: index, metadata: {} });
    }
    // 置き場所の書き方で回を書く: ジョブの詳細は request.json と画像の記録のある回だけを数えるため
    await jobs.writeGeneration(
      job.jobId,
      iteration,
      {
        prompt: '海辺の少女',
        steps: 20,
        cfgScale: 7,
        width: 512,
        height: 512,
        batchSize: PER_ITERATION,
      },
      { images, metadata: {} },
    );
    await append({
      type: 'job.images',
      jobId: job.jobId,
      iteration,
      images: Array.from({ length: PER_ITERATION }, (_, index) => ({ index, seed: index })),
    });
  }
  return { conversationId, jobId: job.jobId };
}

const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-viewer-'));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {import('playwright-core').Browser | undefined} */
let browser;
/** @type {Awaited<ReturnType<typeof startFakeForge>> | undefined} */
let forge;
try {
  const bin = await packAndInstall(work);
  const dataDir = join(work, 'data');
  const { conversationId, jobId } = await seed(dataDir);
  // 偽の Forge に繋ぐ: 画面はバックエンドの状態を読むので、繋がらない先だと 502 がコンソールに出るため
  forge = await startFakeForge({ fixturesDir: FIXTURES, genMs: 0 });
  const port = await freePort();
  ({ child } = await startDrawroid(bin, ['--data-dir', dataDir, '--backend-url', forge.url], port));
  const base = `http://127.0.0.1:${port}`;
  browser = await launchBrowser();

  for (const [width, height, label] of /** @type {const} */ ([
    [1280, 900, '広い画面'],
    [390, 844, '狭い画面'],
  ])) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    const problems = collectProblems(page, base);
    await page.goto(`${base}/conversations/${conversationId}`);

    const first = page.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番（seed 0）' });
    await first.scrollIntoViewIfNeeded();
    await first.click();
    const dialog = page.getByRole('dialog', { name: /1 回目の画像 1 番/ });
    await dialog.waitFor();
    expect(true, `${label}: 縮小版を押すと、その画像の名前の窓が開く`);

    for (let step = 0; step < PER_ITERATION; step += 1) await page.keyboard.press('ArrowRight');
    await page.getByRole('dialog', { name: /2 回目の画像 1 番/ }).waitFor();
    expect(true, `${label}: 右のキーで、回の端を越えて次の回の画像へ送る`);

    if (width < 768) {
      // 狭い画面: 窓と画像が画面に収まり、横にはみ出さない
      const fits = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const img = dialog.querySelector('img');
        const inside = (r) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        return inside(dialog.getBoundingClientRect()) && inside(img.getBoundingClientRect())
          && document.documentElement.scrollWidth <= innerWidth;
      })()`);
      expect(Boolean(fits), `${label}: 窓と画像が画面の中に収まり、横にはみ出さない`);
      // 横へなぞる（右から左）と、次の画像へ送る
      const box = await page.getByRole('dialog').locator('img').boundingBox();
      if (box === null) throw new Error('窓の画像の位置が分からない');
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width * 0.8, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.2, y, { steps: 5 });
      await page.mouse.up();
      await page.getByRole('dialog', { name: /2 回目の画像 2 番/ }).waitFor();
      expect(true, `${label}: 横へなぞると、次の画像へ送る`);
    }

    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const last = width < 768 ? '2 回目の画像 2 番' : '2 回目の画像 1 番';
    // 焦点は、閉じる動きが済んでから戻る
    await page
      .waitForFunction(
        `document.activeElement?.getAttribute("aria-label")?.startsWith(${JSON.stringify(`大きく見る: ${last}`)})`,
        null,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    const focused = await page.evaluate('document.activeElement?.getAttribute("aria-label")');
    expect(
      String(focused).startsWith(`大きく見る: ${last}`),
      `${label}: Esc で閉じ、焦点は最後に見ていた画像（${last}）の縮小版へ戻る（${String(focused)}）`,
    );

    // ジョブの詳細の画像も、同じ窓で大きく見られる
    await page.goto(`${base}/jobs/${jobId}`);
    await page.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番（seed 0）' }).click();
    await page.getByRole('dialog', { name: /1 回目の画像 1 番/ }).waitFor();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    expect(true, `${label}: ジョブの詳細の画像も、同じ窓で大きく見られる`);

    expect(
      problems.length === 0,
      `${label}: コンソールのエラー・失敗した読み込みが無い${problems.length === 0 ? '' : `:\n${problems.join('\n')}`}`,
    );
    await page.close();
  }
} finally {
  await browser?.close();
  child?.kill();
  await forge?.close();
  await rm(work, { recursive: true, force: true });
}
