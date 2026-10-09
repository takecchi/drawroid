// 固めた @drawroid/cli を起動し、ヘッドレスの Chromium で会話を開いて、体験の芯（会話で頼み、思考と途中経過をリアルタイムに見て、
// 割り込める）が画面で回ることを確かめる。偽の LLM と偽の Forge は check-packed-conversation の部品（scripts/packed-conversation/）を使う。
// 1. 思考と返答が流れて画面に出る（思考は、返答が確定する前に出る）
// 2. ジョブが始まると、生成の進み具合のカードが出る
// 3. 話す役のターンの途中で「止める」を押すと、ターンが止まって表示が戻る
// 4. ページを再読み込みしても、ログが同じに戻る。サーバが落ちてつなぎ直したあとも、途切れていた間の発言が1度だけ出る（SSE の復帰）
// 5. 思考が流れている間に入力欄から次の発言を送ると、前のターンが打ち切られ、新しい発言を読んだターンが始まる。返答は二重に残らない
// 6. 見る役が済む前に「この画像でいい」と言うと、会話に「選んだ」が出て（job.adopted）、待たせていたジョブはその画像で止まる
// 7. 狭い画面（390×844）でも、流れる・止めるが同じように動き、入力欄が画面の外へ押し出されない
// 前提: `pnpm build` 済み。ブラウザは取得しない（scripts/packed-browser-core.mjs）。
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import console from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';

import { collectProblems, expect, launchBrowser } from './packed-browser-core.mjs';
import { startFakeForge } from './packed-conversation/forge.mjs';
import { startFakeLlm } from './packed-conversation/llm.mjs';
import { freePort, packAndInstall, repoRoot, startDrawroid } from './packed-install-core.mjs';

const TOTAL_TIMEOUT_MS = 150_000;
const STEP_TIMEOUT_MS = 20_000;
// 進み具合は 1 秒ごとに読まれる。カードが確実に出るよう、それより長く生成させる
const GENERATION_MS = 2_500;
const FIXTURES = join(repoRoot, 'packages/backend-forge/src/test-support/fixtures');
const THINKING = 'どの候補で描くかを考える。夕焼けの色を先に決める。';

/**
 * 偽の LLM の前に立つ中継。話す役の流れの最初の本文・ツールの呼び出しの前に、思考（OpenAI 互換の reasoning_content）の増分を差し込む。
 * 偽の LLM は思考を出さないので、ここで足す（偽の LLM のファイルには手を入れない）。
 * - holdAfterThinking() のあとの1回は、思考を流したところで releaseThinking() まで止める（思考が返答より先に画面に出ること・
 *   思考が流れている間に割り込めることを見るため）
 * - holdJudge() のあとの1回は、見る役の返事を releaseJudge() か呼び手が切るまで返さない（見る役が済む前に人が画像を選ぶため）
 * @param {string} upstream 偽の LLM の /v1
 */
async function startThinkingRelay(upstream) {
  let holdNext = false;
  // 解く合図は先に来てもよい（思考が画面に出た時点で解かれると、中継が止まるより先になりうるため）
  let released = false;
  /** @type {(() => void) | null} */
  let release = null;
  let holdJudgeNext = false;
  /** @type {(() => void) | null} */
  let releaseJudge = null;
  const stats = { judgeHeld: 0, judgeCut: 0, thinkingHeld: 0 };
  /**
   * @param {import('node:http').ServerResponse} res
   * @param {(wake: () => void) => void} keep
   */
  const waitUntil = (res, keep) =>
    new Promise((resolve) => {
      keep(() => resolve(undefined));
      res.on('close', () => resolve(undefined));
    });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      let upstreamResponse;
      try {
        upstreamResponse = await fetch(upstream + req.url?.replace(/^\/v1/, ''), {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body,
          signal: abort.signal,
        });
      } catch {
        // 呼び手（drawroid）が切った: 偽の LLM の待ちも切れている
        return res.destroy();
      }
      const text = await upstreamResponse.text().catch(() => '');
      if (abort.signal.aborted) return;
      const request = JSON.parse(body);
      if (request.model === 'judge-model' && holdJudgeNext) {
        holdJudgeNext = false;
        stats.judgeHeld++;
        await waitUntil(res, (wake) => (releaseJudge = wake));
        releaseJudge = null;
        if (res.destroyed || abort.signal.aborted) {
          stats.judgeCut++;
          return;
        }
      }
      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      res.writeHead(upstreamResponse.status, { 'content-type': contentType });
      const isTalkStream = request.model === 'talk-model' && request.stream === true;
      if (!isTalkStream) return res.end(text);
      const hold = holdNext;
      holdNext = false;
      const lines = text.split('\n\n').filter((line) => line !== '');
      let thought = false;
      for (const line of lines) {
        if (res.destroyed) return;
        if (!thought && (/"content":"[^"]/.test(line) || line.includes('"tool_calls"'))) {
          thought = true;
          // 最初の本文・ツールの呼び出しの前に、思考を数回に分けて流す
          for (let i = 0; i < THINKING.length; i += 8) {
            const chunk = {
              id: 'chatcmpl-fake',
              object: 'chat.completion.chunk',
              created: 0,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: THINKING.slice(i, i + 8) },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            await sleep(20);
          }
          if (hold && !released) {
            stats.thinkingHeld++;
            await waitUntil(res, (wake) => (release = wake));
            release = null;
            if (res.destroyed) return;
          }
        }
        res.write(`${line}\n\n`);
        await sleep(20);
      }
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('中継のポートを取れなかった');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    stats,
    holdAfterThinking: () => {
      holdNext = true;
      released = false;
    },
    releaseThinking: () => {
      released = true;
      release?.();
    },
    holdJudge: () => {
      holdJudgeNext = true;
    },
    releaseJudge: () => releaseJudge?.(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

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

const work = await mkdtemp(
  join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-packed-browser-chat-'),
);
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {import('playwright-core').Browser | undefined} */
let browser;
/** @type {Awaited<ReturnType<typeof startFakeForge>> | undefined} */
let forge;
/** @type {Awaited<ReturnType<typeof startFakeLlm>> | undefined} */
let llm;
/** @type {Awaited<ReturnType<typeof startThinkingRelay>> | undefined} */
let relay;
/** @type {import('playwright-core').Page | undefined} */
let shown;
const overall = setTimeout(() => {
  console.error(`全体の上限 ${TOTAL_TIMEOUT_MS}ms を超えた`);
  child?.kill();
  process.exit(1);
}, TOTAL_TIMEOUT_MS);

try {
  const bin = await packAndInstall(work);
  forge = await startFakeForge({ fixturesDir: FIXTURES, genMs: GENERATION_MS });
  llm = await startFakeLlm({ stopAfterIterations: 2 });
  relay = await startThinkingRelay(llm.url);
  const port = await freePort();
  const dataDir = join(work, 'data');
  const cwd = join(work, 'cwd');
  await mkdir(cwd);
  const env = { ...process.env, FAKE_LLM_KEY: 'fake-key-not-real' };
  const start = () =>
    startDrawroid(bin, ['--data-dir', dataDir, '--backend-url', String(forge?.url)], port, {
      cwd,
      env,
    });
  ({ child } = await start());
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
    providers: {
      fake: { type: 'openai-compatible', baseURL: relay.url, apiKeyEnv: 'FAKE_LLM_KEY' },
    },
    roles: { think: role('think-model'), judge: role('judge-model'), talk: role('talk-model') },
    validationRetries: 1,
    networkRetries: 0,
  });
  const { conversation } = await api(base, 'POST', '/api/conversations', {});
  const conversationUrl = `${base}/conversations/${conversation.conversationId}`;

  browser = await launchBrowser();
  const page = await browser.newPage();
  shown = page;
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const problems = collectProblems(page, base);
  await page.goto(conversationUrl);
  const log = page.getByLabel('会話のログ');
  const composer = page.getByLabel('発言');
  const stopButton = page.getByRole('button', { name: '止める' });
  /** @param {string} text */
  const say = async (text) => {
    await composer.fill(text);
    await composer.press('Enter');
  };

  // 1. 思考と返答が流れて画面に出る。思考は、返答の本文が来る前に出る（流れている）
  relay.holdAfterThinking();
  await say('夕焼けの海辺の少女を描いて');
  await log.getByText(THINKING).waitFor();
  expect(
    !(await log.getByText('描き始めました').isVisible()),
    '思考が、返答より先に流れて画面に出る',
  );
  relay.releaseThinking();
  await log.getByText('描き始めました。少しお待ちください。').waitFor();
  expect(true, '返答が流れて画面に出る');

  // 2. ジョブが始まると、生成の進み具合のカードが出る
  await page.getByLabel('生成の進み具合').first().waitFor();
  expect(true, '生成の進み具合のカードが出る');
  // ジョブが終わるまで待つ（止めるボタンが消える）
  await stopButton.waitFor({ state: 'hidden', timeout: 60_000 });

  // 3. 話す役のターンの途中で止めるを押すと、ターンが止まって表示が戻る
  llm.holdTalk();
  await say('やっぱり猫も入れて');
  await stopButton.waitFor();
  await page.getByText('考えています').first().waitFor();
  await stopButton.click();
  await stopButton.waitFor({ state: 'hidden' });
  await page.getByText('考えています').first().waitFor({ state: 'hidden' });
  expect(await composer.isEnabled(), '止めるを押すと、ターンが止まって表示が戻る');
  expect(llm.stats.abortedTalkCalls >= 1, '止めると、話す役の LLM の呼び出しが切られる');

  /**
   * 偽の相手の状態が整うまで待つ（画面に出ないものを待つため）
   * @param {() => boolean} condition
   * @param {string} what
   */
  const until = async (condition, what) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`待ちきれなかった: ${what}`);
      await sleep(50);
    }
  };
  const REPLY = '描き始めました。少しお待ちください。';
  const events = async () =>
    /** @type {{ seq: number, type: string, turn?: number, outcome?: string, messageSeqs?: number[], text?: string }[]} */ (
      (
        await api(
          base,
          'GET',
          `/api/conversations/${conversation.conversationId}/events?limit=1000`,
        )
      ).events
    );

  // 5. 割り込み: 思考が流れている間に入力欄から次の発言を送ると、前のターンが打ち切られ、両方の発言を読んだターンが始まる。
  // 返答は1つだけ残る
  const repliesBefore = await log.getByText(REPLY).count();
  const heldBefore = relay.stats.thinkingHeld;
  relay.holdAfterThinking();
  // 次のジョブの最初の見る役を止めておく（6 で、見る役が済む前に人が選ぶため）
  relay.holdJudge();
  await say('海辺の猫を描いて');
  await until(() => relay?.stats.thinkingHeld === heldBefore + 1, '思考を流して止まる');
  await say('やっぱり白い猫にして');
  await log.getByText(REPLY).nth(repliesBefore).waitFor();
  await stopButton.waitFor({ state: 'visible' });
  const all = await events();
  const seqOf = (/** @type {string} */ text) =>
    all.find((e) => e.type === 'user.message' && e.text === text)?.seq;
  const ended = all.filter((e) => e.type === 'turn.ended');
  const started = all.filter((e) => e.type === 'turn.started');
  // 打ち切られたターンは前の発言を読み終えているので、次のターンが読むのは新しい発言だけ（前の発言は直近のやりとりとして入力に入る）
  expect(
    ended.at(-1)?.outcome === 'done' &&
      ended.at(-2)?.outcome === 'interrupted' &&
      JSON.stringify(started.at(-2)?.messageSeqs) === JSON.stringify([seqOf('海辺の猫を描いて')]) &&
      JSON.stringify(started.at(-1)?.messageSeqs) ===
        JSON.stringify([seqOf('やっぱり白い猫にして')]),
    '思考が流れている間に送ると、前のターンが打ち切られ、新しい発言を読んだターンが始まる',
  );
  expect(
    (await log.getByText(REPLY).count()) === repliesBefore + 1 &&
      (await log.getByText('打ち切り').count()) === 0,
    '割り込んだあと、画面に返答が二重に残らない',
  );

  // 6. 人が画像を選ぶ: 見る役が済む前に「この画像でいい」と言うと、会話に「選んだ」が出て、待たせていたジョブはその画像で止まる
  await until(() => relay?.stats.judgeHeld === 1, '見る役の返事を止める');
  llm.queueTalkTool('adopt_image', {});
  await say('この画像でいい');
  await log.getByText(/人間が選んだ画像（1 回目の画像 1 番）で決まり/).waitFor();
  expect(true, '人が画像を選ぶと、会話に「選んだ」が出る（job.adopted）');
  await log.getByText('人が画像を選んだ').last().waitFor();
  await stopButton.waitFor({ state: 'hidden' });
  expect(
    relay.stats.judgeCut === 1 &&
      (await page.getByRole('button', { name: /^お気に入りを外す: 1 回目の画像 1 番/ }).count()) >=
        1,
    '待たせていた見る役は呼ばれ直さず、ジョブはその画像をお気に入りにして止まる',
  );

  expect(
    problems.length === 0,
    `コンソールのエラー・失敗した読み込みが無い${problems.length === 0 ? '' : `:\n${problems.join('\n')}`}`,
  );

  // 4a. ページを再読み込みしても、ログが同じに戻る
  const before = await log.innerText();
  await page.reload();
  await log.getByText('やっぱり猫も入れて').waitFor();
  const after = await log.innerText();
  if (after !== before) {
    // 違った行を残す（赤の理由を追えるように）
    const was = before.split('\n');
    const now = after.split('\n');
    console.error(
      `再読み込みの前にだけあった行:\n${was.filter((line) => !now.includes(line)).join('\n')}`,
    );
    console.error(
      `再読み込みの後にだけあった行:\n${now.filter((line) => !was.includes(line)).join('\n')}`,
    );
  }
  expect(after === before, 'ページを再読み込みしても、ログが同じに戻る');

  // 4b. サーバが落ちて、つながっていない間にイベントが書かれても、ブラウザがつなぎ直したあと（Last-Event-ID で続きから）に1度だけ出る。
  // 落とす前に、確定したイベントを流れの上で受け取らせておく: 受け取っていないと、ブラウザは Last-Event-ID を持たず、
  // URL の after でつなぎ直すので、Last-Event-ID の経路を通らないため
  llm.holdTalk();
  const beforeDrop = 'つなぎ直す前の発言';
  await say(beforeDrop);
  await log.getByText(beforeDrop).waitFor();
  await page.getByText('考えています').first().waitFor();
  child.kill();
  await new Promise((resolve) => child?.once('exit', resolve));
  ({ child } = await start());
  // 立て直しで、途切れたターンが閉じられる（turn.ended）。続けて、つながっていない間に発言が置かれる
  llm.holdTalk();
  const missed = 'つながっていない間の発言';
  await api(base, 'POST', `/api/conversations/${conversation.conversationId}/messages`, {
    text: missed,
    clientMessageId: 'browser-check-missed-1',
  });
  await log.getByText(missed).waitFor({ timeout: 30_000 });
  expect(
    (await log.getByText(missed).count()) === 1 && (await log.getByText(beforeDrop).count()) === 1,
    'サーバが落ちてつなぎ直したあと、途切れていた間の発言が1度だけ出る（SSE の復帰）',
  );
  // 4b で止めたままのターンを片づける
  await stopButton.click();
  await stopButton.waitFor({ state: 'hidden' });

  // 7. 狭い画面（390×844）でも、流れる・止めるが同じように動き、入力欄が画面の外へ押し出されない
  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
  narrow.setDefaultTimeout(STEP_TIMEOUT_MS);
  shown = narrow;
  await narrow.goto(conversationUrl);
  const narrowLog = narrow.getByLabel('会話のログ');
  const narrowComposer = narrow.getByLabel('発言');
  const narrowStop = narrow.getByRole('button', { name: '止める' });
  await narrowLog.getByText(missed).waitFor();
  const composerInView = async () => {
    const box = await narrowComposer.boundingBox();
    return box !== null && box.y >= 0 && box.y + box.height <= 844;
  };
  expect(await composerInView(), '狭い画面で、長い会話を開いても入力欄が画面の中にある');
  const narrowReplies = await narrowLog.getByText(REPLY).count();
  const narrowHeld = relay.stats.thinkingHeld;
  relay.holdAfterThinking();
  await narrowComposer.fill('狭い画面から描いて');
  await narrowComposer.press('Enter');
  await until(() => relay?.stats.thinkingHeld === narrowHeld + 1, '思考を流して止まる');
  await narrowLog.getByText(THINKING).filter({ visible: true }).last().waitFor();
  expect(
    (await narrowLog.getByText(REPLY).count()) === narrowReplies,
    '狭い画面でも、思考が返答より先に流れて画面に出る',
  );
  relay.releaseThinking();
  await narrowLog.getByText(REPLY).nth(narrowReplies).waitFor();
  llm.holdTalk();
  await narrowComposer.fill('狭い画面で止める');
  await narrowComposer.press('Enter');
  await narrowStop.waitFor();
  await narrowStop.click();
  await narrowStop.waitFor({ state: 'hidden' });
  expect(
    (await narrowComposer.isEnabled()) && (await composerInView()),
    '狭い画面でも、止めるでターンが止まり、入力欄が画面の中に残る',
  );
} catch (error) {
  // 落ちたときに、画面に何が出ていたかを残す（赤の理由を追えるように）
  const text = await shown
    ?.locator('body')
    .innerText({ timeout: 2_000 })
    .catch(() => '(読めなかった)');
  console.error(`落ちたときの画面:\n${text}`);
  throw error;
} finally {
  clearTimeout(overall);
  await browser?.close();
  child?.kill();
  await relay?.close();
  await llm?.close();
  await forge?.close();
  await rm(work, { recursive: true, force: true });
}
