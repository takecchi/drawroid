// 固めた @drawroid/cli で、会話の画像を大きく見る窓の中から、マスクを塗って送れる（inpaint で割り込める）ことを、ヘッドレスの Chromium で確かめる。
// 1. 走っているジョブの画像を窓で開くと「マスクを塗る」があり、押すと、画像の代わりに塗る面が出る
// 2. 塗っている間は前後へ送れないことが、一行で出る。左右のキーでも、塗る面を横になぞっても、隣の画像へ送らない
// 3. 塗りかけがある間は、Esc でも窓の外を押しても閉じない
// 4. 「マスクを送る」で送ると、ジョブの口出しにマスクが入る（ジョブの詳細の塗る部品と同じ口）
// 5. 閉じるボタンは、塗りかけを捨てて閉じる。開き直すと、塗る前の窓に戻る
// 6. 狭い画面（390×844）でも、塗る面と送るボタンが画面の中に収まり、横にはみ出さない
// 偽の LLM と偽の Forge は check-packed-conversation の部品（scripts/packed-conversation/）を使う。ジョブは回を重ね続けるようにして、塗る間も止めない。
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
// ジョブを確かめの間じゅう走らせておく: 見る役は、この回まで「止めてよい」と言わない
const ITERATIONS = 50;

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

const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-mask-'));
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
  // 会話で描くよう頼む: 偽の話す役が start_drawing を呼び、ジョブが回り始める
  const { conversation } = await api(base, 'POST', '/api/conversations', {});
  await api(base, 'POST', `/api/conversations/${conversation.conversationId}/messages`, {
    text: '夕焼けの海辺の少女を描いて',
    attachments: [],
  });
  browser = await launchBrowser();

  for (const [width, height, label] of /** @type {const} */ ([
    [390, 844, '狭い画面'],
    [1280, 900, '広い画面'],
  ])) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    const problems = collectProblems(page, base);
    await page.goto(`${base}/conversations/${conversation.conversationId}`);
    const thumbnail = page.getByRole('button', { name: /^大きく見る: 1 回目の画像 1 番/ });
    await thumbnail.scrollIntoViewIfNeeded();
    await thumbnail.click();
    const dialog = page.getByRole('dialog', { name: /1 回目の画像 1 番/ });
    await dialog.waitFor();

    // 1. 塗り始めると、画像の代わりに塗る面が出る（原寸の読み込みが済んでから）
    await dialog.getByRole('button', { name: 'マスクを塗る' }).click();
    const canvas = dialog.getByLabel('マスクを塗る所');
    await canvas.waitFor();
    expect(true, `${label}: 窓の中の「マスクを塗る」で、塗る面が出る`);

    // 2. 塗っている間は前後へ送れないことが出て、キーでもなぞりでも送らない
    await dialog.getByText(/塗っている間は前後へ送れません/).waitFor();
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('塗る面の位置が分からない');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.8, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('ArrowRight');
    expect(
      (await page.getByRole('dialog', { name: /1 回目の画像 1 番/ }).count()) === 1,
      `${label}: 塗っている間は、塗る面を横になぞっても、右のキーでも、隣の画像へ送らない`,
    );

    if (width < 768) {
      // 6. 狭い画面でも、塗る面と送るボタンが画面の中に収まる
      const fits = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const canvas = dialog.querySelector('canvas');
        const send = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'マスクを送る');
        const inside = (r) => r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        send?.scrollIntoView({ block: 'nearest' });
        return inside(canvas.getBoundingClientRect()) && send !== undefined && inside(send.getBoundingClientRect())
          && document.documentElement.scrollWidth <= innerWidth;
      })()`);
      expect(Boolean(fits), `${label}: 塗る面と「マスクを送る」が画面の中に収まり、横にはみ出さない`);
    }

    // 3. 塗りかけがある間は、Esc でも窓の外を押しても閉じない
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    expect(
      (await dialog.count()) === 1 &&
        (await dialog.getByText(/Esc や窓の外を押しても閉じません/).count()) === 1,
      `${label}: 塗りかけがある間は、Esc でも窓の外を押しても閉じず、そのことが出る`,
    );

    if (width < 768) {
      // 4. 送ると、ジョブの口出しにマスクが入る
      const { jobs } = await api(base, 'GET', '/api/jobs');
      const jobId = /** @type {{ jobId: string }[]} */ (jobs)[0]?.jobId;
      await dialog.getByRole('button', { name: 'マスクを送る' }).click();
      await dialog.getByText(/送った/).waitFor();
      const { interventions } = await api(base, 'GET', `/api/jobs/auto/${jobId}/interventions`);
      expect(
        /** @type {{ kind: string, image?: { iteration: number, index: number } }[]} */ (
          interventions
        ).some(
          (item) => item.kind === 'mask' && item.image?.iteration === 1 && item.image.index === 0,
        ),
        `${label}: 窓の中で送ったマスクが、その画像（1 回目の 1 番）のマスクとしてジョブに入る`,
      );
      // 送ったあとに、もう一度塗っておく（閉じるボタンが塗りかけを捨てるかを見るため）
      await page.mouse.move(box.x + box.width * 0.3, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, y + 10, { steps: 4 });
      await page.mouse.up();
    }

    // 5. 閉じるボタンは塗りかけを捨てて閉じ、開き直すと塗る前の窓に戻る
    await dialog.getByRole('button', { name: '閉じる' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await thumbnail.click();
    await dialog.getByRole('button', { name: 'マスクを塗る' }).waitFor();
    expect(
      (await dialog.getByLabel('マスクを塗る所').count()) === 0,
      `${label}: 閉じるボタンは塗りかけを捨てて閉じ、開き直すと塗る前の窓に戻る`,
    );
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });

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
  await llm?.close();
  await rm(work, { recursive: true, force: true });
}
