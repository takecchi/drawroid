// 固めた @drawroid/cli で、会話の画像を大きく見る窓の中から、マスクを塗って送れる（inpaint で割り込める）ことを、ヘッドレスの Chromium で確かめる。
// 1. 走っているジョブの画像を窓で開くと「マスクを塗る」があり、押すと、画像の代わりに塗る面が出る
// 2. 塗っている間は前後へ送れないことが、一行で出る。左右のキーでも、塗る面を横になぞっても、隣の画像へ送らない
// 3. 塗りかけがある間は、Esc でも窓の外を押しても閉じない
// 4. 「マスクを送る」で送ると、ジョブの口出しにマスクが入る（ジョブの詳細の塗る部品と同じ口）
// 5. 閉じるボタンは、塗りかけを捨てて閉じる。開き直すと、塗る前の窓に戻る
// 6. 狭い画面（390×844）でも広い画面でも、塗る面と送るボタンが画面の中に収まり、はみ出さない
// 7. ジョブの詳細の人間の指示にも、塗ったマスクが、画像を 1 から数えた名前で出る
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
  // 原寸を画面より大きくする: 小さな画像では、塗る面の大きさの指定が無くても収まってしまい、収まりの確かめが効かないため
  forge = await startFakeForge({ fixturesDir: FIXTURES, genMs: 500, imageSize: 1024 });
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

    // ツールの行は、人が読む見出しと短い要約で出し、生の呼び出し（JSON）は「詳しく」に畳む
    const toolRow = page.getByRole('group', { name: 'ツール 描き始める: 済み' });
    await toolRow.waitFor();
    expect(
      !(await toolRow.getByText(/stopConditions/).isVisible()) &&
        (await toolRow.locator('details summary').textContent()) === '詳しく',
      `${label}: ツールの行は「描き始める」と出し、生の呼び出しは「詳しく」に畳む`,
    );
    // 見えている要約にはジョブの ID を出さない（閉じた「詳しく」の中の全文には残る）
    const shownText = String(
      await toolRow.evaluate((el) => /** @type {HTMLElement} */ (el).innerText),
    );
    expect(
      !/\d{8}-\d{6}-[0-9a-z]+/.test(shownText) && shownText.includes('ジョブで描き始めた。'),
      `${label}: ツールの行の要約に、ジョブの ID を出さない（見えている文字: ${shownText.replace(/\n/g, ' / ')}）`,
    );
    if (width < 768) {
      // 描いている間も、入力欄が細くならない: 止める・送るは印だけで、名前は読み上げに残る
      const stop = page.getByRole('button', { name: '止める' });
      await stop.waitFor();
      const send = page.getByRole('button', { name: '送る' });
      const field = await page.getByLabel('発言').boundingBox();
      const stopBox = await stop.boundingBox();
      const sendBox = await send.boundingBox();
      expect(
        field !== null &&
          stopBox !== null &&
          sendBox !== null &&
          field.width >= 200 &&
          stopBox.width <= 56 &&
          sendBox.width <= 56,
        `${label}: 描いている間も入力欄は 200px 以上あり、止める・送るは印だけ（欄 ${field?.width}px・止める ${stopBox?.width}px・送る ${sendBox?.width}px）`,
      );
    }

    const thumbnail = page.getByRole('button', { name: /^大きく見る: .*1 回目の画像 1 番/ });
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
    await dialog.getByText(/塗っている間は前後へ送れない/).waitFor();
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

    {
      // 6. どの画面の幅でも、塗る面と送るボタンが画面の中に収まる（広い画面では、画面より高い原寸が縦にはみ出さない）
      const fits = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const canvas = dialog.querySelector('canvas');
        // 塗る面が重なる画像。画像がはみ出すと、塗る面（入れ物に合わせて置かれる）とずれ、塗った所と画像の所が食い違う
        const image = canvas.parentElement.querySelector('img');
        const send = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'マスクを送る');
        const inside = (r) => r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        send?.scrollIntoView({ block: 'nearest' });
        const a = canvas.getBoundingClientRect();
        const b = image.getBoundingClientRect();
        const same = Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
        return inside(a) && inside(b) && same && send !== undefined && inside(send.getBoundingClientRect())
          && document.documentElement.scrollWidth <= innerWidth;
      })()`);
      expect(
        Boolean(fits),
        `${label}: 塗る面・その画像・「マスクを送る」が画面の中に収まり、塗る面と画像の大きさがそろい、横にはみ出さない`,
      );
    }

    // 3. 塗りかけがある間は、Esc でも窓の外を押しても閉じない
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    expect(
      (await dialog.count()) === 1 &&
        (await dialog.getByText(/Esc や窓の外を押しても閉じない/).count()) === 1,
      `${label}: 塗りかけがある間は、Esc でも窓の外を押しても閉じず、そのことが出る`,
    );

    if (width < 768) {
      // 4. 送ると、ジョブの口出しにマスクが入る
      const { jobs } = await api(base, 'GET', '/api/jobs');
      const jobId = /** @type {{ jobId: string }[]} */ (jobs)[0]?.jobId;
      await dialog.getByRole('button', { name: 'マスクを送る' }).click();
      await dialog.getByText('マスクを送った。次の回で描き直す。').waitFor();
      const { interventions } = await api(base, 'GET', `/api/jobs/auto/${jobId}/interventions`);
      expect(
        /** @type {{ kind: string, image?: { iteration: number, index: number } }[]} */ (
          interventions
        ).some(
          (item) => item.kind === 'mask' && item.image?.iteration === 1 && item.image.index === 0,
        ),
        `${label}: 窓の中で送ったマスクが、その画像（1 回目の 1 番）のマスクとしてジョブに入る`,
      );
      // 送ったら見る形に戻る: 塗る面は消え、「マスクを塗る」に戻り、前後へ送れる
      // 送った知らせは塗る道具の中にも同じ文で出るので、文が出ただけでは見る形に戻ったとは言えない。塗る面が消えるのを待つ
      await dialog.getByLabel('マスクを塗る所').waitFor({ state: 'detached' });
      const returned = {
        sentNote: await dialog.getByText('マスクを送った。次の回で描き直す。').count(),
        paintButton: await dialog.getByRole('button', { name: 'マスクを塗る' }).count(),
        lockNote: await dialog.getByText(/塗っている間は前後へ送れない/).count(),
        nextEnabled: await dialog.getByRole('button', { name: '次の画像' }).isEnabled(),
      };
      expect(
        returned.sentNote === 1 &&
          returned.paintButton === 1 &&
          returned.lockNote === 0 &&
          returned.nextEnabled,
        `${label}: マスクを送ると見る形に戻り、送ったことが短く出て、前後へ送れる（${JSON.stringify(returned)}）`,
      );
      // もう一度塗っておく（閉じるボタンが塗りかけを捨てるかを見るため）
      await dialog.getByRole('button', { name: 'マスクを塗る' }).click();
      const again = dialog.getByLabel('マスクを塗る所');
      await again.waitFor();
      const againBox = await again.boundingBox();
      if (againBox === null) throw new Error('塗る面の位置が分からない');
      const againY = againBox.y + againBox.height / 2;
      await page.mouse.move(againBox.x + againBox.width * 0.3, againY);
      await page.mouse.down();
      await page.mouse.move(againBox.x + againBox.width * 0.6, againY + 10, { steps: 4 });
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

    // 8. 末尾にいる間は、行が増えても「新しい行」の印を出さない。上を読んでいる間に行が増えたら出し、押すと末尾へ戻る
    const logBox = page.getByRole('log', { name: '会話のログ' });
    const marker = page.getByRole('button', { name: '新しい行へ' });
    const atEnd = () =>
      page.evaluate(`(() => { const b = document.querySelector('[role="log"]');
        return b.scrollTop + b.clientHeight >= b.scrollHeight - 4; })()`);
    const rowsNow = () =>
      page.evaluate(`document.querySelector('[role="log"] > div').children.length`);
    await logBox.hover();
    await page.mouse.wheel(0, 100_000);
    await page.waitForFunction(`(() => { const b = document.querySelector('[role="log"]');
      return b.scrollTop + b.clientHeight >= b.scrollHeight - 4; })()`);
    const rowsAtEnd = Number(await rowsNow());
    // 一瞬だけ出て消える形も数える: 終わってから数えるだけでは、末尾へ寄せた直後に消える点滅を見逃すため
    await page.evaluate(`(() => { window.__markerSeen = 0; const log = document.querySelector('[role="log"]');
      new MutationObserver(() => { if (log.querySelector('[aria-label="新しい行へ"]')) window.__markerSeen += 1; })
        .observe(log, { childList: true, subtree: true }); })()`);
    // ジョブは回り続けているので、行が増えるのを待つ
    await page.waitForFunction(
      `document.querySelector('[role="log"] > div').children.length > ${rowsAtEnd}`,
    );
    expect(
      Number(await page.evaluate('window.__markerSeen')) === 0 && Boolean(await atEnd()),
      `${label}: 末尾にいる間は、行が増えても「新しい行」の印を出さず、末尾を追う`,
    );
    await page.mouse.wheel(0, -3_000);
    await marker.waitFor();
    expect(true, `${label}: 上を読んでいる間に行が増えたら、「新しい行」の印を出す`);
    await marker.click();
    await page.waitForFunction(`(() => { const b = document.querySelector('[role="log"]');
      return b.scrollTop + b.clientHeight >= b.scrollHeight - 4; })()`);
    expect((await marker.count()) === 0, `${label}: 「新しい行」を押すと末尾へ戻り、印は消える`);

    expect(
      problems.length === 0,
      `${label}: コンソールのエラー・失敗した読み込みが無い${problems.length === 0 ? '' : `:\n${problems.join('\n')}`}`,
    );
    await page.close();
  }

  // 7. ジョブの詳細の人間の指示にも、窓で塗ったマスクが、画像を 1 から数えた名前で出る（会話の画面の呼び方にそろう）
  {
    const { jobs } = await api(base, 'GET', '/api/jobs');
    const jobId = /** @type {{ jobId: string }[]} */ (jobs)[0]?.jobId;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    await page.goto(`${base}/jobs/${jobId}`);
    await page.getByText('1 回目の画像 1 番にマスクを塗った').waitFor();
    expect(
      true,
      'ジョブの詳細の人間の指示に、塗ったマスクが「1 回目の画像 1 番」と 1 から数えて出る',
    );
    // 見出しは依頼の文（偽の話す役が start_drawing に渡す文）で、ID は下の並びにある
    const heading = await page.getByRole('heading', { level: 1 }).textContent();
    expect(
      heading === '夕焼けの海辺の少女' &&
        (await page.locator('dd code').first().textContent()) === jobId,
      `ジョブの詳細の見出しは依頼の文で、ID は下の並びにある（見出し: ${String(heading)}）`,
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
