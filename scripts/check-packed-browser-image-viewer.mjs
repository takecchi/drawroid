// 固めた @drawroid/cli で、会話の画像を大きく見る窓（ImageViewer）が、ヘッドレスの Chromium で次のとおり動くかを確かめる。
// 1. 縮小版は「大きく見る: N 回目の画像 M 番」という名前のボタンで、押すと、その画像の名前の窓が開く
// 2. 左右のキーで、同じ回の隣の画像へ、端まで来たら次の回の画像へ送る
// 3. Esc で閉じ、焦点は最後に見ていた画像の縮小版へ戻る
// 4. 狭い画面（390×844）でも、窓と画像が画面の中に収まり、横にはみ出さない。横へなぞると次の画像へ送る
// 5. ジョブの詳細の画像も、同じ窓で大きく見られる
// 6. 窓の中で、見る役の点と言葉が読め、お気に入り・却下が使え、止まったジョブでは「この画像に決める（お気に入りにする）」が出る（画像の枡と同じ口）
// 7. 人が会話で添えた画像は、発言の行に縮小版で並び（読み上げではどの発言のものか分かる名前）、狭い画面でも横にはみ出さず、
//    押すと同じ窓で大きく見られ、閉じると焦点がその縮小版へ戻る
// 会話は、組み立てた @drawroid/storage-fs で置き場所へ直に書いてから起動する（画像を生成せずに画像の行を作るため）。
// 前提: `pnpm build` 済み。ブラウザは取得しない（scripts/packed-browser-core.mjs）。
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

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
    await append({
      type: 'job.judge',
      jobId: job.jobId,
      iteration,
      images: Array.from({ length: PER_ITERATION }, (_, index) => ({
        index,
        score: 0.5 + index / 10,
        issues: [`${iteration} 回目の ${index + 1} 枚目の指摘`],
      })),
      nextChange: '背景を明るく',
      canStop: false,
    });
  }
  // ジョブは止まっている（会話にもそう書く）: 画面は会話の job.stopped で、「この画像で決める」を押せなくするため
  await append({
    type: 'job.stopped',
    jobId: job.jobId,
    reason: { kind: 'human', detail: '確かめのため' },
  });
  return { conversationId, jobId: job.jobId };
}

/**
 * 人が画像を2枚添えた発言だけの会話を、置き場所へ直に書く（大きさの違う画像で、縮小版の枡に収まるかも見る）
 * @param {string} root データディレクトリ
 * @returns {Promise<string>} 会話 ID
 */
async function seedAttached(root) {
  const storage = await import(join(repoRoot, 'packages/storage-fs/dist/index.js'));
  const sharp = createRequire(join(repoRoot, 'packages/storage-fs/package.json'))('sharp');
  const conversations = new storage.FsConversationStore(root);
  const { conversationId } = await conversations.createConversation(new Date());
  const uploadIds = [];
  for (const [width, height] of [
    [1200, 400],
    [300, 900],
  ]) {
    const png = await sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } },
    })
      .png()
      .toBuffer();
    uploadIds.push(
      await conversations.addUpload(
        conversationId,
        { data: new Uint8Array(png), mediaType: 'image/png' },
        new Date(),
      ),
    );
  }
  await conversations.appendEvent(
    conversationId,
    {
      type: 'user.message',
      text: 'この2枚の雰囲気で描いて',
      attachments: uploadIds.map((uploadId) => ({ uploadId })),
    },
    new Date(),
  );
  return conversationId;
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
  const attachedId = await seedAttached(dataDir);
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

    // 窓の中で、見る役の点と言葉が読め、お気に入り・却下と「この画像で決める」が使える（画像の枡と同じ口）
    await dialog.getByText('見る役の点 0.50').waitFor();
    await dialog.getByText('1 回目の 1 枚目の指摘').waitFor();
    const favorite = dialog.getByRole('button', { name: 'お気に入り: 1 回目の画像 1 番' });
    await favorite.click();
    await dialog
      .getByRole('button', { name: 'お気に入りを外す: 1 回目の画像 1 番', pressed: true })
      .waitFor();
    // 押したら元に戻す（次の画面の幅でも、同じ形から確かめるため）
    await dialog.getByRole('button', { name: 'お気に入りを外す: 1 回目の画像 1 番' }).click();
    await favorite.waitFor();
    // このジョブは止まっているので、採る口（「この画像で決める」）も押せない理由も出ず、止まりのカードと同じ
    // 「この画像に決める（お気に入りにする）」になる。押すとお気に入りになり、採る口は呼ばれない。
    // 採る口へ送ったかは、ジョブの口出しではなく送った読み込みで見る: 止まったジョブは採る口を断る（409）ので、送っても口出しは増えないため
    /** @type {string[]} */
    const sent = [];
    /** @param {import('playwright-core').Request} request */
    const onRequest = (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET' && path.startsWith(`/api/jobs/${jobId}/`)) {
        sent.push(`${request.method()} ${path}`);
      }
    };
    page.on('request', onRequest);
    expect(
      (await dialog
        .getByRole('button', { name: 'この画像で決める: 1 回目の画像 1 番' })
        .count()) === 0 && (await dialog.getByText(/決められない/).count()) === 0,
      `${label}: 止まったジョブでは、窓の中に採る口も押せない理由も出ない`,
    );
    await dialog
      .getByRole('button', { name: 'この画像に決める（お気に入りにする）: 1 回目の画像 1 番' })
      .click();
    await dialog.getByText('お気に入り', { exact: true }).waitFor();
    // 押したら元に戻す（次の画面の幅でも、同じ形から確かめるため）。戻し終えるまでに送ったものを見る
    await dialog.getByRole('button', { name: 'お気に入りを外す: 1 回目の画像 1 番' }).click();
    await favorite.waitFor();
    page.off('request', onRequest);
    expect(
      sent.some((what) => what.startsWith(`PUT /api/jobs/${jobId}/selections/`)) &&
        !sent.some((what) => what.endsWith('/adopt')),
      `${label}: 窓の中の「この画像に決める（お気に入りにする）」でお気に入りになり、採る口は呼ばれない（送ったもの: ${sent.join(', ')}）`,
    );
    expect(
      true,
      `${label}: 窓の中で、見る役の点と言葉が読め、お気に入りを付け外しでき、止まったジョブでは「この画像に決める（お気に入りにする）」が出る`,
    );

    for (let step = 0; step < PER_ITERATION; step += 1) await page.keyboard.press('ArrowRight');
    await page.getByRole('dialog', { name: /2 回目の画像 1 番/ }).waitFor();
    expect(true, `${label}: 右のキーで、回の端を越えて次の回の画像へ送る`);

    if (width < 768) {
      // 測る・なぞる前に、送った先の画像の読み込みを待つ: 送った直後は新しい画像が読み込み中で幅が 0 のことがあり、
      // そのまま測ると収まりの確かめが素通りし、画像の幅を基準になぞると動きが 0 になってスワイプにならない（遅い CI で当たる）
      await page.waitForFunction(
        `(() => { const img = document.querySelector('[role="dialog"] img'); return img !== null && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 0; })()`,
      );
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
    const jobDialog = page.getByRole('dialog', { name: /1 回目の画像 1 番/ });
    await jobDialog.waitFor();
    // ジョブの詳細でも、止まったジョブの画像には採る口も押せない理由も出ず、「この画像に決める（お気に入りにする）」が出る（会話と同じ部品）
    await jobDialog
      .getByRole('button', { name: 'この画像に決める（お気に入りにする）: 1 回目の画像 1 番' })
      .waitFor();
    expect(
      (await jobDialog
        .getByRole('button', { name: 'この画像で決める: 1 回目の画像 1 番' })
        .count()) === 0 && (await jobDialog.getByText(/決められない/).count()) === 0,
      `${label}: ジョブの詳細でも、止まったジョブの窓には採る口も押せない理由も出ず、「この画像に決める（お気に入りにする）」が出る`,
    );
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    expect(true, `${label}: ジョブの詳細の画像も、同じ窓で大きく見られる`);

    // 人が会話で添えた画像は、発言の行に縮小版で並ぶ
    await page.goto(`${base}/conversations/${attachedId}`);
    const attached = page.getByRole('list', { name: '添えた画像（2 枚）' });
    await attached.waitFor();
    const second = page.getByRole('button', {
      name: '大きく見る: 添えた画像 2 枚目（「この2枚の雰囲気で描いて」）',
    });
    await page
      .getByRole('button', {
        name: '大きく見る: 添えた画像 1 枚目（「この2枚の雰囲気で描いて」）',
      })
      .waitFor();
    await second.waitFor();
    expect(true, `${label}: 添えた画像は、どの発言のものか分かる名前の縮小版で並ぶ`);
    // 縮小版が読み込まれ、決まった枡に収まり、画面から横にはみ出さない
    await page.waitForFunction(`(() => {
      const images = [...document.querySelectorAll('[aria-label="添えた画像（2 枚）"] img')];
      return images.length === 2 && images.every((img) => img.complete && img.naturalWidth > 0);
    })()`);
    const thumbnails = await page.evaluate(`(() => {
      const images = [...document.querySelectorAll('[aria-label="添えた画像（2 枚）"] img')];
      return JSON.stringify({
        sizes: images.map((img) => { const r = img.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
        inside: images.every((img) => { const r = img.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }),
        noScroll: document.documentElement.scrollWidth <= innerWidth,
      });
    })()`);
    const { sizes, inside, noScroll } = JSON.parse(String(thumbnails));
    expect(
      sizes.every(/** @param {number[]} s */ (s) => s[0] === 64 && s[1] === 64) &&
        inside &&
        noScroll,
      `${label}: 添えた画像の縮小版は、縦長も横長も同じ枡に収まり、横にはみ出さない（${String(thumbnails)}）`,
    );
    await second.click();
    await page.getByRole('dialog', { name: /添えた画像 2 枚目/ }).waitFor();
    expect(true, `${label}: 添えた画像も、押すと同じ窓で大きく見られる`);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page
      .waitForFunction(
        `document.activeElement?.getAttribute("aria-label")?.startsWith("大きく見る: 添えた画像 2 枚目")`,
        null,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    const backTo = await page.evaluate('document.activeElement?.getAttribute("aria-label")');
    expect(
      String(backTo).startsWith('大きく見る: 添えた画像 2 枚目'),
      `${label}: 閉じると、焦点は添えた画像の縮小版へ戻る（${String(backTo)}）`,
    );

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
