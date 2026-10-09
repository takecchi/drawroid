// 利用者として通しで使う（探索用。リポジトリには入れない）。一歩ごとに撮り、失敗しても次へ進む。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { collectProblems, launchBrowser } from './packed-browser-core.mjs';
import { makePng, startFakeForge } from './packed-conversation/forge.mjs';
import { startFakeLlm } from './packed-conversation/llm.mjs';
import { freePort, packAndInstall, repoRoot, startDrawroid } from './packed-install-core.mjs';

const OUT = process.env.WALK_OUT ?? '/tmp/mgr-49b993b8/walk';
const FIXTURES = join(repoRoot, 'packages/backend-forge/src/test-support/fixtures');
const PREVIEW = makePng(3, 256).toString('base64');

/** 偽の Forge の前に立ち、進み具合に途中の画像を差し込む */
async function startPreviewRelay(upstream) {
  const server = createServer((req, res) => {
    let body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', async () => {
      const r = await fetch(upstream + req.url, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(body),
      });
      let text = Buffer.from(await r.arrayBuffer());
      if (req.url?.startsWith('/sdapi/v1/progress')) {
        const json = JSON.parse(text.toString());
        if (json.progress > 0.2) json.current_image = PREVIEW;
        text = Buffer.from(JSON.stringify(json));
      }
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

const work = await mkdtemp(join(tmpdir(), 'drawroid-walk-'));
const bin = await packAndInstall(work);
const browser = await launchBrowser();
try {
  for (const [width, height, label] of [
    [1280, 900, 'wide'],
    [390, 844, 'narrow'],
  ].filter(([, , l]) => (process.env.WALK_ONLY ?? l) === l)) {
    const dir = join(OUT, label);
    await mkdir(dir, { recursive: true });
    const notes = [];
    const forge = await startFakeForge({ fixturesDir: FIXTURES, genMs: 6000 });
    const relay = await startPreviewRelay(forge.url);
    const llm = await startFakeLlm({ stopAfterIterations: 4 });
    const port = await freePort();
    const { child } = await startDrawroid(bin, ['--data-dir', join(work, `data-${label}`)], port);
    const base = `http://127.0.0.1:${port}`;
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(20_000);
    const problems = collectProblems(page, base);
    let n = 0;
    const shot = async (name, full = false) => {
      n += 1;
      const path = join(dir, `${String(n).padStart(2, '0')}-${name}.png`);
      await page.screenshot({ path, fullPage: full }).catch((e) => notes.push(`撮れない ${name}: ${e}`));
      return path;
    };
    const step = async (name, fn) => {
      try {
        await fn();
        notes.push(`ok   ${name}`);
      } catch (error) {
        notes.push(`NG   ${name}: ${String(error).split('\n')[0]}`);
        await shot(`NG-${name}`);
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    };
    const nav = async (linkName) => {
      if (width < 768) await page.getByRole('button', { name: 'メニューを開く' }).click();
      await page.getByRole('link', { name: linkName, exact: true }).first().click();
    };

    // 1. 初めて開く → 案内に従って設定する
    await step('はじめて開く', async () => {
      await page.goto(`${base}/`);
      await page.getByRole('note', { name: 'はじめに要る設定' }).waitFor();
      await shot('first-open', true);
    });
    await step('案内から LLM の設定へ', async () => {
      await page.getByRole('link', { name: 'LLM を設定する' }).click();
      await page.getByLabel('provider 1番目 の名前').waitFor();
      await shot('settings-llm-empty', true);
      await page.getByLabel('provider 1番目 の名前').fill('local');
      await page.getByLabel('provider local の接続先（baseURL）').fill(llm.url);
      await page.getByLabel('考える役の provider').fill('local');
      await page.getByLabel('考える役のモデル').fill('talk-model');
      await shot('settings-llm-filled', true);
      await page.getByRole('button', { name: 'LLM の設定を保存' }).click();
      await page.getByText('まだ LLM が設定されていない').waitFor({ state: 'hidden' });
      await shot('settings-llm-saved', true);
    });
    await step('バックエンドの URL を入れる', async () => {
      await page.getByLabel('バックエンドの URL').fill(relay.url);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await sleep(1500);
      await shot('settings-backend-saved', true);
    });
    await step('途中の画像を有効にする', async () => {
      const box = page.getByRole('checkbox', { name: '生成の途中の画像を出す' });
      await box.scrollIntoViewIfNeeded();
      if (!(await box.isChecked())) await box.click();
      await page.getByText('保存した。次に始まる生成から効く。').waitFor();
      await shot('settings-progress-on');
    });
    await step('まとめて確かめる', async () => {
      llm.queueTalkTool('doctor_ping', {});
      await page.getByRole('button', { name: '確かめる' }).click();
      await page.getByText(/1往復できた/).first().waitFor({ timeout: 40_000 });
      await sleep(500);
      await shot('settings-doctor', true);
    });

    // 2. 会話で頼み、画像を1枚添える
    await step('新しい会話を作る', async () => {
      await nav('会話');
      await page.getByRole('button', { name: '新しい会話' }).or(page.getByRole('link', { name: '新しい会話' })).first().click();
      await page.getByLabel('発言').waitFor();
      await shot('conversation-empty');
    });
    await step('画像を添えて「猫を描いて」と頼む', async () => {
      await page.getByLabel('添える画像を選ぶ').setInputFiles([
        { name: 'neko.png', mimeType: 'image/png', buffer: makePng(5, 256) },
      ]);
      await sleep(500);
      await page.getByLabel('発言').fill('猫を描いて');
      await shot('composer-attached');
      llm.queueTalkTool('start_drawing', {
        request: '猫',
        stopConditions: { aiJudgement: true, maxIterations: 6 },
      });
      await page.getByLabel('発言').press('Enter');
      await page.getByLabel('会話のログ').getByText('猫を描いて').waitFor();
      await sleep(2500);
      await shot('after-send');
    });

    // 3. 途中経過を見る
    await step('途中の画像が出る', async () => {
      await page.getByRole('img', { name: /途中の画像/ }).first().waitFor({ timeout: 40_000 });
      await shot('progress-preview');
    });

    // 4. 途中で口を出し、窓からマスクを塗る
    await step('途中で口を出す', async () => {
      llm.queueTalkTool('revise_drawing', { instruction: '背景を夜にして' });
      await page.getByLabel('発言').fill('背景を夜にして');
      await page.getByLabel('発言').press('Enter');
      await page.getByText(/指示を伝えた|背景を夜/).first().waitFor({ timeout: 30_000 });
      await sleep(1500);
      await shot('after-revise');
    });
    await step('窓からマスクを塗って送る', async () => {
      const thumb = page.getByRole('button', { name: /^大きく見る: 1 回目の画像 1 番/ });
      await thumb.waitFor({ timeout: 40_000 });
      await thumb.scrollIntoViewIfNeeded();
      await thumb.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await shot('viewer-open');
      await dialog.getByRole('button', { name: 'マスクを塗る' }).click();
      const canvas = dialog.getByLabel('マスクを塗る所');
      await canvas.waitFor();
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 6 });
      await page.mouse.up();
      await shot('viewer-painting');
      await dialog.getByRole('button', { name: 'マスクを送る' }).click();
      await dialog.getByText(/送った/).waitFor();
      await shot('viewer-mask-sent');
      await dialog.getByRole('button', { name: '閉じる' }).click();
    });

    // 5. 止まったら、止まりのカードから選び、覚えたことを見る
    await step('止まりのカード', async () => {
      await page.getByText(/描くのを止めた/).first().waitFor({ timeout: 120_000 });
      await sleep(1500);
      await page.getByText(/描くのを止めた/).first().scrollIntoViewIfNeeded();
      await shot('stop-card');
    });
    await step('止まりのカードから選ぶ', async () => {
      await page.getByRole('button', { name: /^この画像に決める（お気に入りにする）/ }).first().click();
      await sleep(2500);
      await shot('stop-card-chosen');
    });
    await step('覚えたことを見る', async () => {
      await sleep(3000);
      await nav('記憶');
      await sleep(1500);
      await shot('memory', true);
    });

    // 6. ジョブの詳細へ移る。会話を開き直す
    await step('ジョブの詳細へ', async () => {
      await page.goBack();
      await page.getByRole('link', { name: 'ジョブの詳細' }).last().click();
      await page.waitForURL(/\/jobs\//);
      await sleep(1500);
      await shot('job-detail', true);
    });
    await step('会話を開き直す', async () => {
      await nav('会話');
      await sleep(800);
      await shot('conversation-list');
      await page.getByRole('link', { name: /猫/ }).first().click();
      await page.getByLabel('発言').waitFor();
      await sleep(1500);
      await shot('conversation-reopened');
      await shot('conversation-reopened-full', true);
    });

    notes.push(`problems: ${problems.length}`, ...problems);
    await writeFile(join(dir, 'notes.txt'), notes.join('\n'));
    console.log(`--- ${label}\n${notes.join('\n')}`);
    await page.close();
    child.kill();
    await forge.close();
    await llm.close();
    relay.close();
  }
} finally {
  await browser.close();
  await rm(work, { recursive: true, force: true });
}
