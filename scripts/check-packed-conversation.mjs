// 固めた @drawroid/cli を npm install し、偽の Forge・偽の LLM をつないで、会話 → 発言 → start_drawing → 進み具合 → 画像と評価 → 停止、を最後まで通す。
// 前提: `pnpm build` 済み。外のサービスには繋がない（偽物は 127.0.0.1 に立てる）。
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import console from 'node:console';
import { tmpdir } from 'node:os';
import { TextDecoder } from 'node:util';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { startFakeForge } from './packed-conversation/forge.mjs';
import { startFakeLlm } from './packed-conversation/llm.mjs';
import { freePort, packAndInstall, repoRoot, startDrawroid } from './packed-install-core.mjs';

const TOTAL_TIMEOUT_MS = 120_000;
const STOP_AFTER_ITERATIONS = 2;
// drawroid の進み具合の取得は 1 秒間隔（core の既定）。1 回は流れるよう、それより長く待たせる。
const GENERATION_MS = 1_600;
const FIXTURES = join(repoRoot, 'packages/backend-forge/src/test-support/fixtures');

/**
 * @typedef {{ id?: string, event?: string, data?: any }} Frame
 * @typedef {{ status: number, contentType: string | null, frames: Frame[], close: () => void }} Sse
 */

/** @type {string[]} */
const failures = [];
/**
 * @param {boolean} ok
 * @param {string} what
 * @param {string} [detail]
 */
function assert(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(detail === '' ? what : `${what} — ${detail}`);
}

/** @param {string} base @param {string} conversationId @param {Record<string, string>} headers @returns {Promise<Sse>} */
async function openSse(base, conversationId, headers) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/conversations/${conversationId}/stream`, {
    headers,
    signal: controller.signal,
  });
  /** @type {Frame[]} */
  const frames = [];
  const reader = async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const part of /** @type {AsyncIterable<Uint8Array>} */ (response.body)) {
        buffer += decoder.decode(part, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          /** @type {Frame} */
          const frame = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
          }
          if (frame.event !== undefined) frames.push(frame);
        }
      }
    } catch {
      // close() による中断
    }
  };
  void reader();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    frames,
    close: () => controller.abort(),
  };
}

/** @param {() => boolean} condition @param {string} what */
async function waitFor(condition, what) {
  for (;;) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (Date.now() > deadline) throw new Error(`${what} を待っている間に時間切れ`);
  }
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
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

const started = Date.now();
const deadline = started + TOTAL_TIMEOUT_MS;
const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'drawroid-conversation-'));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {(() => string) | undefined} */
let drawroidOutput;
/** @type {Awaited<ReturnType<typeof startFakeForge>> | undefined} */
let forge;
/** @type {Awaited<ReturnType<typeof startFakeLlm>> | undefined} */
let llm;
/** @type {Sse[]} */
const streams = [];
// 全体の上限: どこかで固まっても CI を塞がない。止まったら finally が後片付けしてから落ちる。
const timer = setTimeout(() => {
  console.error(`全体の上限 ${TOTAL_TIMEOUT_MS}ms を超えた`);
  child?.kill();
  process.exit(1);
}, TOTAL_TIMEOUT_MS + 10_000);

try {
  const bin = await packAndInstall(work);
  forge = await startFakeForge({ fixturesDir: FIXTURES, genMs: GENERATION_MS });
  llm = await startFakeLlm({ stopAfterIterations: STOP_AFTER_ITERATIONS });
  const port = await freePort();
  const dataDir = join(work, 'data');
  const cwd = join(work, 'cwd');
  await mkdir(cwd);
  ({ child, output: drawroidOutput } = await startDrawroid(
    bin,
    ['--data-dir', dataDir, '--backend-url', forge.url],
    port,
    {
      cwd,
      env: {
        ...process.env,
        FAKE_LLM_KEY: 'fake-key-not-real',
        FAKE_OPENAI_KEY: 'fake-key-not-real',
        FAKE_ANTHROPIC_KEY: 'fake-key-not-real',
      },
    },
  ));
  const base = `http://127.0.0.1:${port}`;

  /** @param {string} model @param {'native' | 'json'} toolCalling @param {string} [provider] */
  const role = (model, toolCalling, provider = 'fake') => ({
    provider,
    model,
    structuredOutput: 'native',
    reasoning: 'native',
    toolCalling,
    imageInput: true,
  });
  const fakeLlmUrl = llm.url;
  const fakeProvider = {
    type: 'openai-compatible',
    baseURL: fakeLlmUrl,
    apiKeyEnv: 'FAKE_LLM_KEY',
  };
  /** @param {'native' | 'json'} toolCalling @param {Record<string, unknown>} [providers] @param {string} [provider] */
  const putLlm = (toolCalling, providers = {}, provider = 'fake') =>
    api(base, 'PUT', '/api/settings/llm', {
      providers: { fake: fakeProvider, ...providers },
      roles: {
        think: role('think-model', 'native'),
        judge: role('judge-model', 'native'),
        talk: role('talk-model', toolCalling, provider),
      },
      validationRetries: 1,
      networkRetries: 0,
    });
  const put = await putLlm('native');
  assert(put.status === 200, 'PUT /api/settings/llm が 200', `${put.status} ${put.text}`);

  const conversation = await api(base, 'POST', '/api/conversations', {});
  assert(
    conversation.status === 201,
    '会話の作成が 201',
    `${conversation.status} ${conversation.text}`,
  );
  const conversationId = String(conversation.json?.conversation?.conversationId);

  const main = await openSse(base, conversationId, {});
  streams.push(main);
  assert(
    main.status === 200 && (main.contentType ?? '').startsWith('text/event-stream'),
    'SSE が 200・text/event-stream',
    `${main.status} ${main.contentType}`,
  );

  const say = await api(base, 'POST', `/api/conversations/${conversationId}/messages`, {
    text: '夕焼けの海辺の少女を描いて',
    clientMessageId: 'c1',
  });
  assert(say.status === 202, '発言が 202', `${say.status} ${say.text}`);

  // 途中から開き直す: 最初の進み具合が流れた時点で、turn.started（seq 2）の続きを頼む。
  // 進み具合が流れないまま止まった・ジョブが始まらないまま話が終わったときは、時間切れを待たずに先へ進んで、外れた確認として出す
  const has = (/** @type {Sse} */ s, /** @type {string} */ type) =>
    s.frames.some((f) => f.event === type);
  await waitFor(
    () =>
      has(main, 'generation.progress') ||
      has(main, 'job.stopped') ||
      (has(main, 'turn.ended') && !has(main, 'job.started')),
    'generation.progress',
  );
  const RESUME_AFTER = 2;
  const late = await openSse(base, conversationId, { 'last-event-id': String(RESUME_AFTER) });
  streams.push(late);

  const stopped = (/** @type {Sse} */ s) => s.frames.some((f) => f.event === 'job.stopped');
  if (has(main, 'job.started')) await waitFor(() => stopped(main) && stopped(late), 'job.stopped');
  else await waitFor(() => has(late, 'turn.ended'), 'turn.ended');

  const confirmed = main.frames.filter((f) => f.id !== undefined);
  const types = confirmed.map((f) => f.event);
  const ofType = (/** @type {string} */ type) => confirmed.filter((f) => f.event === type);

  const call = ofType('tool.call')[0];
  assert(
    call?.data?.name === 'start_drawing',
    'tool.call（start_drawing）が確定する',
    JSON.stringify(types),
  );
  const result = ofType('tool.result')[0];
  assert(result?.data?.ok === true, 'tool.result が ok で確定する', JSON.stringify(result?.data));

  const progress = main.frames.filter((f) => f.event === 'generation.progress');
  assert(
    progress.length >= 1,
    'generation.progress が SSE で 1 件以上流れる',
    `${progress.length} 件`,
  );
  assert(
    progress.every((f) => f.id === undefined),
    'generation.progress は確定イベント（id 付き）ではない',
  );

  assert(
    ofType('job.images').length === STOP_AFTER_ITERATIONS,
    `job.images が ${STOP_AFTER_ITERATIONS} 回確定する`,
    JSON.stringify(types),
  );
  assert(
    ofType('job.judge').length === STOP_AFTER_ITERATIONS,
    `job.judge が ${STOP_AFTER_ITERATIONS} 回確定する`,
    JSON.stringify(types),
  );
  assert(ofType('job.stopped').length === 1, 'job.stopped が 1 回確定する', JSON.stringify(types));

  // 順が定まらないもの（reasoning・distill・turn.ended など）は見ない。部分列として並んでいればよい
  const expected = [
    'user.message',
    'turn.started',
    'tool.call',
    'job.started',
    'tool.result',
    'job.think',
    'job.images',
    'job.judge',
    'job.think',
    'job.images',
    'job.judge',
    'job.stopped',
  ];
  let at = 0;
  for (const type of types) if (type === expected[at]) at++;
  assert(
    at === expected.length,
    '確定イベントの並びが期待どおり',
    `${expected[at] ?? '(完了)'} が見つからない。実際: ${types.join(',')}`,
  );

  const ids = confirmed.map((f) => Number(f.id));
  assert(
    ids.every((id, i) => id === i + 1),
    '確定イベントの id が 1 から欠けず並ぶ',
    ids.join(','),
  );

  const lateIds = late.frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
  const wantIds = ids.filter((id) => id > RESUME_AFTER);
  assert(
    late.status === 200 && (late.contentType ?? '').startsWith('text/event-stream'),
    'Last-Event-ID 付きの SSE が 200・text/event-stream',
    `${late.status} ${late.contentType}`,
  );
  assert(
    lateIds.length === wantIds.length && lateIds.every((id, i) => id === wantIds[i]),
    `Last-Event-ID: ${RESUME_AFTER} で、続きの id から重複なしで来る`,
    `来た id: ${lateIds.join(',')} / 期待: ${wantIds.join(',')}`,
  );

  const jobId = String(ofType('job.started')[0]?.data?.jobId);
  for (let iteration = 1; iteration <= STOP_AFTER_ITERATIONS; iteration++) {
    for (const [file, type] of [
      ['0.png', 'image/png'],
      ['0.preview.webp', 'image/webp'],
    ]) {
      const path = `/api/files/jobs/${jobId}/iterations/${iteration}/images/${file}`;
      const response = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
      const bytes = (await response.arrayBuffer()).byteLength;
      assert(
        response.status === 200 && response.headers.get('content-type') === type && bytes > 0,
        `GET ${path} が 200・${type}`,
        `${response.status} ${response.headers.get('content-type')} ${bytes}B`,
      );
    }
  }

  // events/ には確定したものだけが残る。空のディレクトリを見て通ってしまわないよう、job.stopped が在ることも見る
  const eventsDir = join(dataDir, 'conversations', conversationId, 'events');
  const names = await readdir(eventsDir);
  const stored = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(eventsDir, name), 'utf8')).type),
  );
  assert(stored.includes('job.stopped'), 'events/ に job.stopped が残る', `${names.length} 件`);
  assert(!stored.includes('generation.progress'), 'events/ に generation.progress は残らない');
  assert(
    names.length === confirmed.length,
    'events/ の件数が SSE で確定した件数と一致する',
    `${names.length} / ${confirmed.length}`,
  );
  assert(
    llm.stats.nativeTalkCalls >= 1 && llm.stats.jsonTalkCalls === 0,
    'native のとき、台本の LLM は native のツール呼び出しで呼ばれる',
    JSON.stringify(llm.stats),
  );

  // toolCalling: json。会話を短く通す（見る役は 1 回目で止める）。native に倒れて通っただけ、を見逃さないよう、json の経路で呼ばれた数も見る
  llm.restartJudge(1);
  const nativeCallsBefore = llm.stats.nativeTalkCalls;
  const putJson = await putLlm('json');
  assert(
    putJson.status === 200,
    'toolCalling: json の設定の PUT が 200',
    `${putJson.status} ${putJson.text}`,
  );
  const jsonConversation = await api(base, 'POST', '/api/conversations', {});
  const jsonConversationId = String(jsonConversation.json?.conversation?.conversationId);
  const jsonStream = await openSse(base, jsonConversationId, {});
  streams.push(jsonStream);
  const jsonSay = await api(base, 'POST', `/api/conversations/${jsonConversationId}/messages`, {
    text: '夕焼けの海辺の少女を描いて',
    clientMessageId: 'c2',
  });
  assert(
    jsonSay.status === 202,
    'toolCalling: json の発言が 202',
    `${jsonSay.status} ${jsonSay.text}`,
  );
  await waitFor(
    () => stopped(jsonStream) || (has(jsonStream, 'turn.ended') && !has(jsonStream, 'job.started')),
    'toolCalling: json の job.stopped',
  );
  const jsonConfirmed = jsonStream.frames.filter((f) => f.id !== undefined);
  const jsonTypes = jsonConfirmed.map((f) => f.event);
  const jsonCall = jsonConfirmed.find((f) => f.event === 'tool.call');
  const jsonResult = jsonConfirmed.find((f) => f.event === 'tool.result');
  assert(
    jsonCall?.data?.name === 'start_drawing',
    'toolCalling: json で tool.call（start_drawing）が確定する',
    JSON.stringify(jsonTypes),
  );
  assert(
    jsonResult?.data?.ok === true,
    'toolCalling: json で tool.result が ok で確定する',
    JSON.stringify(jsonResult?.data),
  );
  assert(
    jsonConfirmed.filter((f) => f.event === 'job.stopped').length === 1,
    'toolCalling: json で job.stopped が 1 回確定する',
    JSON.stringify(jsonTypes),
  );
  assert(
    llm.stats.jsonTalkCalls >= 1 && llm.stats.nativeTalkCalls === nativeCallsBefore,
    'toolCalling: json のとき、台本の LLM は json の経路で呼ばれ、native のツール呼び出しは使われない',
    JSON.stringify(llm.stats),
  );

  // provider の openai・anthropic。設定の保存の時点で LLM を組み立てるので、固めたものの中でアダプタが読めることがここで分かる。
  // 実 API は呼ばない: baseURL は 127.0.0.1 の使われないポート
  const unusedUrl = 'http://127.0.0.1:9/v1';
  /** @type {['openai' | 'anthropic', string][]} */
  const providerTypes = [
    ['openai', 'FAKE_OPENAI_KEY'],
    ['anthropic', 'FAKE_ANTHROPIC_KEY'],
  ];
  for (const [type, keyEnv] of providerTypes) {
    const result = await putLlm(
      'native',
      { [type]: { type, baseURL: unusedUrl, apiKeyEnv: keyEnv } },
      type,
    );
    assert(
      result.status === 200,
      `provider ${type} の設定を PUT でき、固めたものの中でアダプタが読める`,
      `${result.status} ${result.text}`,
    );
  }
  const restored = await putLlm('native');
  assert(
    restored.status === 200,
    '台本の LLM の設定に戻せる',
    `${restored.status} ${restored.text}`,
  );

  // 中断。ターンの途中（話す役の LLM の応答待ち）と、ジョブの生成の途中を、偽の LLM・Forge を合図まで待たせて作る。
  // 1 つ目の発言でジョブを始め、Forge の生成で止める。ターンが終わったあとの 2 つ目の発言を、話す役の応答待ちで止める。
  /** @param {string} text @param {string} clientMessageId @returns {Promise<{ stream: Sse, id: string, say: () => Promise<void> }>} */
  const startConversation = async (text, clientMessageId) => {
    const created = await api(base, 'POST', '/api/conversations', {});
    const id = String(created.json?.conversation?.conversationId);
    const stream = await openSse(base, id, {});
    streams.push(stream);
    const say = async () => {
      const sent = await api(base, 'POST', `/api/conversations/${id}/messages`, {
        text,
        clientMessageId,
      });
      assert(
        sent.status === 202,
        `発言（${clientMessageId}）が 202`,
        `${sent.status} ${sent.text}`,
      );
    };
    return { stream, id, say };
  };
  const count = (/** @type {Sse} */ s, /** @type {string} */ type) =>
    s.frames.filter((f) => f.event === type && f.id !== undefined).length;
  /** ジョブが Forge の生成で止まり、1 つ目のターンが終わり、2 つ目の発言の話す役の応答待ちで止まるところまで進める */
  const reachMidTurn = async (
    /** @type {Sse} */ stream,
    /** @type {() => Promise<void>} */ say1,
    /** @type {() => Promise<void>} */ say2,
    /** @type {string} */ label,
  ) => {
    forge?.holdGeneration();
    const heldBefore = forge?.stats.heldGenerations ?? 0;
    await say1();
    await waitFor(
      () =>
        ((forge?.stats.heldGenerations ?? 0) > heldBefore && count(stream, 'turn.ended') >= 1) ||
        (count(stream, 'turn.ended') >= 1 && !has(stream, 'job.started')),
      `${label}: Forge の生成待ちと 1 つ目の turn.ended`,
    );
    const talkHeldBefore = llm?.stats.heldTalkCalls ?? 0;
    llm?.holdTalk();
    await say2();
    await waitFor(
      () => (llm?.stats.heldTalkCalls ?? 0) > talkHeldBefore || count(stream, 'turn.ended') >= 2,
      `${label}: 2 つ目のターンの話す役の応答待ち`,
    );
  };
  const endedTurns = (/** @type {Sse} */ s) =>
    s.frames.filter((f) => f.event === 'turn.ended' && f.id !== undefined);

  // scope: turn。ターンだけ打ち切り、描いているジョブは止まらず続く
  llm.restartJudge(1);
  const turnConv = await startConversation('夕焼けの海辺の少女を描いて', 't1');
  await reachMidTurn(
    turnConv.stream,
    turnConv.say,
    async () => {
      const sent = await api(base, 'POST', `/api/conversations/${turnConv.id}/messages`, {
        text: '空をもう少し赤く',
        clientMessageId: 't2',
      });
      assert(sent.status === 202, '中断する前の 2 つ目の発言（turn）が 202', `${sent.status}`);
    },
    'turn',
  );
  assert(
    has(turnConv.stream, 'job.started') && !has(turnConv.stream, 'job.images'),
    'turn: 中断の時点で、ジョブは Forge の生成の途中',
    JSON.stringify(turnConv.stream.frames.map((f) => f.event)),
  );
  const turnInterrupt = await api(base, 'POST', `/api/conversations/${turnConv.id}/interrupt`, {
    scope: 'turn',
  });
  const turnJobId = String(
    turnConv.stream.frames.find((f) => f.event === 'job.started')?.data?.jobId,
  );
  assert(
    turnInterrupt.status === 202,
    'interrupt（turn）が 202',
    `${turnInterrupt.status} ${turnInterrupt.text}`,
  );
  assert(
    turnInterrupt.json?.scope === 'turn' &&
      turnInterrupt.json?.interruptedTurn === true &&
      turnInterrupt.json?.stoppedJob === null,
    'interrupt（turn）の応答が scope: turn・interruptedTurn: true・stoppedJob: null',
    turnInterrupt.text,
  );
  await waitFor(() => endedTurns(turnConv.stream).length >= 2, 'turn: 2 つ目の turn.ended');
  const turnEnded = endedTurns(turnConv.stream)[1];
  assert(
    turnEnded?.data?.outcome === 'interrupted',
    'interrupt（turn）で、話す役のターンが outcome interrupted で終わる',
    JSON.stringify(turnEnded?.data),
  );
  assert(
    (llm?.stats.abortedTalkCalls ?? 0) >= 1,
    'interrupt（turn）で、話す役の LLM の呼び出しが切られる',
    JSON.stringify(llm?.stats),
  );
  assert(
    (forge?.stats.interrupts ?? 0) === 0 && !has(turnConv.stream, 'job.stopped'),
    'interrupt（turn）では、ジョブを止めない（Forge に interrupt が行かず、job.stopped も出ない）',
    `interrupts=${forge?.stats.interrupts} ${JSON.stringify(turnConv.stream.frames.map((f) => f.event))}`,
  );
  // 生成を解くと、ターンが終わったあともジョブが回り続け、自分で（ai の判断で）終わる
  forge.releaseGeneration();
  await waitFor(() => stopped(turnConv.stream), 'turn: job.stopped');
  const turnConfirmed = turnConv.stream.frames.filter((f) => f.id !== undefined);
  const turnEndedAt = turnConfirmed.indexOf(/** @type {Frame} */ (turnEnded));
  const turnStoppedAt = turnConfirmed.findIndex((f) => f.event === 'job.stopped');
  assert(
    turnConfirmed.some((f, i) => i > turnEndedAt && f.event === 'job.images') &&
      turnConfirmed.some((f, i) => i > turnEndedAt && f.event === 'job.judge'),
    'interrupt（turn）のあとも、ジョブの job.images・job.judge が続けて確定する',
    JSON.stringify(turnConfirmed.map((f) => f.event)),
  );
  assert(
    turnConfirmed[turnStoppedAt]?.data?.jobId === turnJobId &&
      turnConfirmed[turnStoppedAt]?.data?.reason?.kind === 'ai',
    'interrupt（turn）のあと、ジョブは human ではなく自分の判断（ai）で止まる',
    JSON.stringify(turnConfirmed[turnStoppedAt]?.data),
  );

  // scope: all。ターンもジョブも止める
  llm.restartJudge(3);
  const allConv = await startConversation('夕焼けの海辺の少女を描いて', 'a1');
  await reachMidTurn(
    allConv.stream,
    allConv.say,
    async () => {
      const sent = await api(base, 'POST', `/api/conversations/${allConv.id}/messages`, {
        text: '空をもう少し赤く',
        clientMessageId: 'a2',
      });
      assert(sent.status === 202, '中断する前の 2 つ目の発言（all）が 202', `${sent.status}`);
    },
    'all',
  );
  const allJobId = String(
    allConv.stream.frames.find((f) => f.event === 'job.started')?.data?.jobId,
  );
  const allInterrupt = await api(base, 'POST', `/api/conversations/${allConv.id}/interrupt`, {
    scope: 'all',
  });
  assert(
    allInterrupt.status === 202,
    'interrupt（all）が 202',
    `${allInterrupt.status} ${allInterrupt.text}`,
  );
  assert(
    allInterrupt.json?.scope === 'all' &&
      allInterrupt.json?.interruptedTurn === true &&
      allInterrupt.json?.stoppedJob === allJobId,
    'interrupt（all）の応答が scope: all・interruptedTurn: true・stoppedJob: 描いていたジョブの id',
    `${allInterrupt.text} / jobId ${allJobId}`,
  );
  await waitFor(
    () => endedTurns(allConv.stream).length >= 2 && stopped(allConv.stream),
    'all: 2 つ目の turn.ended と job.stopped',
  );
  const allEnded = endedTurns(allConv.stream)[1];
  assert(
    allEnded?.data?.outcome === 'interrupted',
    'interrupt（all）で、話す役のターンが outcome interrupted で終わる',
    JSON.stringify(allEnded?.data),
  );
  const allStopped = allConv.stream.frames.filter(
    (f) => f.event === 'job.stopped' && f.id !== undefined,
  );
  assert(
    allStopped.length === 1 &&
      allStopped[0]?.data?.jobId === allJobId &&
      allStopped[0]?.data?.reason?.kind === 'human',
    'interrupt（all）で、ジョブが 1 回だけ、reason human で止まる（job.stopped）',
    JSON.stringify(allStopped.map((f) => f.data)),
  );
  assert(
    (forge?.stats.interrupts ?? 0) >= 1 && !has(allConv.stream, 'job.judge'),
    'interrupt（all）で、Forge の生成が止められ、評価（job.judge）まで進まない',
    `interrupts=${forge?.stats.interrupts}`,
  );
  // 走っているものが無いときは、何もせず 202
  const idle = await api(base, 'POST', `/api/conversations/${allConv.id}/interrupt`, {
    scope: 'all',
  });
  assert(
    idle.status === 202 && idle.json?.interruptedTurn === false && idle.json?.stoppedJob === null,
    '走っているものが無いときの interrupt は 202 で、interruptedTurn: false・stoppedJob: null',
    `${idle.status} ${idle.text}`,
  );

  // 起動時に「LLM が未設定」と出したあと、設定を保存したことが端末から分かる
  assert(
    (drawroidOutput?.() ?? '').includes('LLM の設定を読み込んだ'),
    'LLM の設定を保存すると「LLM の設定を読み込んだ」と出る',
  );
} catch (error) {
  assert(false, '確かめの途中で例外', error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timer);
  for (const stream of streams) stream.close();
  child?.kill();
  await forge?.close();
  await llm?.close();
  await rm(work, { recursive: true, force: true });
}

console.log(`所要 ${Date.now() - started}ms`);
if (failures.length > 0) {
  console.error(`\n外れた確認 ${failures.length} 件:\n${failures.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('すべて通った');
