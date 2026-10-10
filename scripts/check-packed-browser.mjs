// 固めた @drawroid/cli を空のディレクトリへ npm install して起動し、ヘッドレスの Chromium で Web UI を開けることを確かめる
// （M0 の受け入れ基準「ブラウザで Web UI が開ける」）。HTTP の確かめ（check-packed-install）では見えない、JS が動いて画面が描かれること・
// CSS が効いていること・コンソールにエラーが出ないことを見る。
// 続けて、はじめの一歩（未設定の案内から LLM を設定して、話す役と1往復する）をたどる。
// 前提: `pnpm build` 済み（web の build/client が要る）。
// ブラウザは取得しない（scripts/packed-browser-core.mjs の launchBrowser）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { collectProblems, expect, launchBrowser } from './packed-browser-core.mjs';
import { startFakeLlm } from './packed-conversation/llm.mjs';
import { freePort, packAndInstall, startDrawroid } from './packed-install-core.mjs';

const STEP_TIMEOUT_MS = 15_000;
/** doctor が話す役にツールを続けて呼ばせる回数（apps/cli/src/doctor.ts の TALK_PING_ROUNDS） */
const DOCTOR_TALK_ROUNDS = 3;

const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-browser-'));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {import('playwright-core').Browser | undefined} */
let browser;
/** @type {Awaited<ReturnType<typeof startFakeLlm>> | undefined} */
let llm;
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

  browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  // バックエンドを立てないので、バックエンドの状態の読み込みは失敗するのが想定どおり
  const problems = collectProblems(page, base, { expected: (url) => url.includes('/api/backend') });

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

  // キーボードで最初に届くのは「本文へ移動」で、押すと焦点が本文の枠に入る。枠は tabIndex={-1} が無いと焦点を受けられず、
  // 押しても焦点が link に残る（jsdom の試験は枠を自前で置くので、root.tsx の枠はここでしか見られない）
  const focused = async () =>
    String(
      await page.evaluate(
        'document.activeElement ? document.activeElement.id || document.activeElement.textContent : ""',
      ),
    );
  await page.keyboard.press('Tab');
  const firstStop = await focused();
  expect(firstStop === '本文へ移動', `Tab で最初に「本文へ移動」に届く（焦点: ${firstStop}）`);
  const urlBeforeSkip = page.url();
  await page.keyboard.press('Enter');
  const afterSkip = await focused();
  expect(
    afterSkip === 'main-content',
    `「本文へ移動」を押すと、焦点が本文の枠に入る（焦点: ${afterSkip.slice(0, 40)}）`,
  );
  expect(page.url() === urlBeforeSkip, '「本文へ移動」を押しても URL は変わらない');

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

  // JS が届かないとき（遅い・止まった・失敗した）にも、本文が空のまま（真っ白）にならない。読み込み中と出し、
  // 時間が経ったら次にすることを出す。JS を止めた別の画面で見る（CSS は届く）
  const blocked = await browser.newPage();
  await blocked.route('**/*.js', (route) => route.abort());
  await blocked.goto(`${base}/`);
  await blocked.getByText('読み込んでいます…').waitFor();
  expect(true, 'JS が届かなくても、本文に「読み込んでいます…」が出る');
  // 案内は透明のまま置いてあり、時間が経つと見えるようになる（透明でも Playwright は「見える」と数えるので、不透明さを待つ）
  await blocked
    .getByText('読み込みに時間がかかっている', { exact: false })
    .waitFor({ state: 'attached' });
  expect(
    String(
      await blocked.evaluate(
        'getComputedStyle(document.querySelector(".hydrate-slow-hint")).opacity',
      ),
    ) === '0',
    '読み込みの直後は、時間の案内はまだ見えない',
  );
  await blocked.waitForFunction(
    'getComputedStyle(document.querySelector(".hydrate-slow-hint")).opacity === "1"',
    undefined,
    { timeout: 15_000 },
  );
  expect(true, '時間が経つと、再読み込みとターミナルの確かめを促す案内が出る');
  await blocked.close();

  // はじめの一歩: LLM もバックエンドも未設定から、案内をたどって LLM を設定し、話す役と1往復する。
  // バックエンドは立てない（初めて開いた人と同じ）。LLM は check-packed-conversation の偽物を、ローカルの OpenAI 互換の LLM の代わりに使う
  llm = await startFakeLlm({ stopAfterIterations: 1 });
  await page.goto(`${base}/`);
  const notice = page.getByRole('note', { name: 'はじめに要る設定' });
  await notice.getByRole('link', { name: 'LLM を設定する' }).waitFor();
  await notice.getByRole('link', { name: 'バックエンドを確かめる' }).waitFor();
  expect(true, '最初の画面に、LLM とバックエンドが足りないことと、設定への道が出る');

  await page.goto(`${base}/conversations/${conversation.conversationId}`);
  const log = page.getByLabel('会話のログ');
  const composer = page.getByLabel('発言');
  await composer.fill('こんにちは');
  await composer.press('Enter');
  // 見るのは、このターンが閉じた失敗の行（role="alert"）。ログの上の「はじめに要る設定」の案内にも「LLM が未設定」と出るので、
  // 文言だけで探すと、返事の前は案内に当たって返事を見ずに進み、両方そろったあとでは 2 つに当たって落ちる
  await log
    .getByRole('alert')
    .filter({ hasText: /^応答が失敗した: LLM が未設定/ })
    .waitFor();
  await notice.getByRole('link', { name: 'LLM を設定する' }).click();
  await page.waitForURL(`${base}/settings#llm`);
  // 設定の画面は、初めての人に要るもの（バックエンドと LLM）が上にあり、予算は「詳しい設定」として畳んである。
  // 測る前に、画面が描き終わるのを待つ: URL が変わった直後は、まだ前の画面か読み込み中の形で、位置が測れないことがあるため
  await page.getByLabel('provider 1番目 の名前').waitFor();
  await page.locator('details#budgets').waitFor({ state: 'attached' });
  const order = await page.evaluate(
    '["backend", "llm", "budgets"].map((id) => (document.getElementById(id)?.getBoundingClientRect().top ?? NaN) + window.scrollY)',
  );
  expect(
    Array.isArray(order) && order[0] < order[1] && order[1] < order[2],
    `設定の画面は、バックエンド・LLM・詳しい設定の順に並ぶ（上端: ${JSON.stringify(order)}）`,
  );
  expect(
    (await page.locator('details#budgets').getAttribute('open')) === null,
    '予算は「詳しい設定」として畳んである',
  );
  // バックエンドに繋がらないときは、何が起きたかとすることを出し、サーバの生の文（URL 入り）は「詳しく」に畳む（同じ文が2回並ばない）
  const backendBox = page.locator('#backend');
  await backendBox
    .getByText(/に繋がらない。/)
    .first()
    .waitFor();
  const folded = backendBox.locator('details', {
    has: page.locator('summary', { hasText: '詳しく' }),
  });
  expect(
    (await folded.count()) === 1 &&
      (await folded.getAttribute('open')) === null &&
      /127\.0\.0\.1/.test((await folded.textContent()) ?? ''),
    'バックエンドの状態は、サーバの生の文（URL 入り）を「詳しく」に畳む',
  );
  // 狭い画面（390 幅）でも、provider の欄（接続先など）が provider の枠からはみ出さない
  const wideViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflowing = await page.evaluate(`(() => {
    const box = document.querySelector('[aria-label="provider 1番目 の名前"]').closest('fieldset').getBoundingClientRect();
    return [...document.querySelectorAll('fieldset input, fieldset select')]
      .filter((el) => el.closest('fieldset').contains(document.querySelector('[aria-label="provider 1番目 の名前"]')))
      .filter((el) => el.getBoundingClientRect().right > box.right + 0.5)
      .map((el) => el.getAttribute('aria-label') ?? el.name);
  })()`);
  expect(
    Array.isArray(overflowing) && overflowing.length === 0,
    `狭い画面でも、provider の欄が provider の枠からはみ出さない（はみ出し: ${JSON.stringify(overflowing)}）`,
  );
  if (wideViewport !== null) await page.setViewportSize(wideViewport);
  await page.getByLabel('provider 1番目 の名前').fill('local');
  await page.getByLabel('provider local の接続先（baseURL）').fill(llm.url);
  // 役の provider は、上で定義した provider から選ぶ。1つだけなら、はじめから選んである
  expect(
    (await page.getByRole('combobox', { name: '考える役の provider' }).inputValue()) === 'local',
    '役の provider は打つ欄ではなく、定義した provider が1つだけなら、はじめからそれを選んである',
  );
  await page.getByLabel('考える役のモデル').fill('talk-model');
  await page.getByRole('button', { name: 'LLM の設定を保存' }).click();
  await page.getByText('まだ LLM が設定されていない').waitFor({ state: 'hidden' });
  expect(true, '案内から LLM の設定へ行き、保存できる');
  // 生成の途中の画像は、既定では出さない（設計書の推奨の13）。設定の画面で有効にでき、保存した値は API でも開き直しても同じ
  const previewBox = page.getByRole('checkbox', { name: '生成の途中の画像を出す' });
  await previewBox.waitFor();
  expect(!(await previewBox.isChecked()), '生成の途中の画像は、既定では出さない');
  await previewBox.check();
  await page.getByText('保存した。次に始まる生成から効く。').waitFor();
  const savedPreview = /** @type {{ includePreview: boolean }} */ (
    await (
      await fetch(`${base}/api/settings/generation-progress`, {
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      })
    ).json()
  );
  expect(
    savedPreview.includePreview === true,
    '設定の画面で、生成の途中の画像を出すようにでき、保存される',
  );
  // 設定したら、まとめて確かめる（drawroid doctor と同じ確かめ）: LLM とは1往復でき、バックエンドが無いことが、することと一緒に出る
  llm.queueTalkTool('doctor_ping', {}, DOCTOR_TALK_ROUNDS);
  await page.getByRole('button', { name: '確かめる' }).click();
  await page
    .getByRole('region', { name: 'LLM' })
    .getByText(/話す役.*1往復できた/)
    .waitFor();
  await page
    .getByRole('region', { name: '画像のバックエンド（Forge）' })
    .getByText(/すること: Forge を --api を付けて起動する/)
    .waitFor();
  expect(
    true,
    '設定の画面の「確かめる」で、LLM と1往復でき、バックエンドが無いことと、することが出る',
  );
  // 前のリンク（/generate#llm）は、設定の画面の同じ欄へ送られる
  await page.goto(`${base}/generate#llm`);
  await page.waitForURL(`${base}/settings#llm`);
  await page.getByRole('checkbox', { name: '生成の途中の画像を出す', checked: true }).waitFor();
  expect(true, '前のリンク（/generate#llm）は、設定の画面の LLM の欄へ送られる');

  await page.goto(`${base}/conversations/${conversation.conversationId}`);
  await composer.fill('海辺の少女を描いて');
  await composer.press('Enter');
  // バックエンドは立てていないので、話す役は描き始めずに、繋がらないことと次にすることを返す（初めて開いた人と同じ）
  await log
    .getByText(/描き始められない: 画像のバックエンド（Forge \/ A1111）に繋がらない/)
    .first()
    .waitFor();
  expect(
    (await notice.getByRole('link', { name: 'LLM を設定する' }).count()) === 0 &&
      (await notice.getByRole('link', { name: 'バックエンドを確かめる' }).count()) === 1,
    '設定したあとは案内から LLM が消え、話す役が返事をする（未設定から設定して1往復）。バックエンドが無いことも伝わる',
  );

  // 記憶の画面は、まだ空でも、何がいつここに入るのかを一言で出す
  await page.goto(`${base}/memory`);
  await page.getByText('まだ無い。').waitFor();
  await page.getByText(/描いたジョブが止まったときと、止まったあとに選び直したときに/).waitFor();
  expect(true, '記憶の画面は、空でも何がいつ入るのかを出す');

  // 押す所は、狭い画面でも、広い画面を指で操作するとき（pointer: coarse）でも 44px。広い画面をマウスで操作するとき（pointer: fine）だけ詰める
  for (const [width, height, touch, large, label] of /** @type {const} */ ([
    [390, 844, false, true, '狭い画面（マウス）'],
    [1024, 768, true, true, '広い画面（指）'],
    [1280, 900, false, false, '広い画面（マウス）'],
  ])) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
    const sized = await context.newPage();
    sized.setDefaultTimeout(STEP_TIMEOUT_MS);
    await sized.goto(`${base}/settings`);
    const save = sized.getByRole('button', { name: 'LLM の設定を保存' });
    await save.waitFor();
    // 前提: 指で操作する文脈だけが pointer: coarse に当たる（当たらなければ、この段は確かめにならない）
    const coarse = await sized.evaluate(`matchMedia('(pointer: coarse)').matches`);
    const saveHeight = (await save.boundingBox())?.height ?? 0;
    const link = sized.getByRole('navigation').getByRole('link', { name: '設定' });
    const linkHeight = width >= 768 ? ((await link.boundingBox())?.height ?? 0) : undefined;
    expect(
      coarse === touch &&
        (large
          ? saveHeight >= 44 && (linkHeight === undefined || linkHeight >= 44)
          : saveHeight === 36 && linkHeight === 32),
      `${label}: 押す所は${large ? '指で押せる 44px 以上' : '詰めた大きさのまま'}（pointer: coarse ${coarse}・保存 ${saveHeight}px・脇の設定 ${linkHeight ?? '-'}px）`,
    );
    await context.close();
  }

  expect(
    problems.length === 0,
    `コンソールのエラー・失敗した読み込みが無い${problems.length === 0 ? '' : `:\n${problems.join('\n')}`}`,
  );
} finally {
  await browser?.close();
  child?.kill();
  await llm?.close();
  await rm(work, { recursive: true, force: true });
}
