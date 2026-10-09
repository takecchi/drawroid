// ジョブの詳細の画面の試験に流す記録を、実行器が実際に残すとおりの形で取り込む。
// 使い方: pnpm build && node scripts/record-job-detail-fixtures.mjs
// 実行器・保存・API は dist をそのまま使う。時計と ID の生成だけを固定のものに差し替えるので、何度回しても同じ出力になる。
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import console from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { createApi } from '../packages/api/dist/index.js';
import {
  basicPermissions,
  ConversationHubs,
  DEFAULT_BUDGET,
  DEFAULT_GENERATION_PROGRESS_SETTINGS,
  JobRunner,
  ManualGenerationRunner,
  ProgressPreviews,
  resolveBudgets,
} from '../packages/core/dist/index.js';
import {
  MemoryConversationStore,
  ScriptedLlm,
  StubBackend,
} from '../packages/core/dist/testing/index.js';
import {
  createFsDistillLog,
  createFsMemoryStore,
  dataPaths,
  FsJobStore,
} from '../packages/storage-fs/dist/index.js';

const OUT = fileURLToPath(new URL('../apps/web/app/test-support/fixtures/', import.meta.url));
const requireFromApi = createRequire(new URL('../packages/api/package.json', import.meta.url));
const sharp = requireFromApi('sharp');

const REQUEST = '夕暮れの海辺に立つ白いワンピースの少女、アニメ調';
const INSTRUCTION = '逆光にして';
const GIST = '白いワンピースの裾が風になびく構図';
const BROKEN_CALL_ID = '20260101T000099000Z-broken';

// 固定の時計: 呼ばれるたびに1秒進む。実行器は1本ずつ順に回るので、呼ばれる順も毎回同じになる
let tick = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
// 固定の呼び出し ID: 名前の順が呼び出しの順になる形（実物と同じ約束）を保つ
let callSeq = 0;
const newCallId = (/** @type {Date} */ at) =>
  `${at.toISOString().replaceAll(/[-:.]/g, '')}-${String(callSeq++).padStart(6, '0')}`;
let jobSeq = 0;
const randomSuffix = () => String(jobSeq++).padStart(6, '0');

const root = await mkdtemp(join(tmpdir(), 'drawroid-record-fixtures-'));
const store = new FsJobStore(root, { randomSuffix });
const backend = new StubBackend();

/** @type {{ request: (path: string, init?: RequestInit) => Response | Promise<Response> } | undefined} */
let app;
/** @param {string} method @param {string} path @param {unknown} [body] @returns {Promise<any>} */
async function call(method, path, body) {
  if (app === undefined) throw new Error('app が未構築');
  const res = await app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return await res.json();
}

let jobId = '';
const think = (/** @type {unknown} */ _call, /** @type {number} */ n) => ({
  params: {
    prompt: `girl, beach, sunset, take ${n + 1}`,
    negativePrompt: 'lowres',
    seed: 1,
    steps: 20,
    cfgScale: 7,
  },
  rationale: `${n + 1} 回目の案`,
  intent: REQUEST,
});
// 1回目の見る役の返事を返す前に口出しを入れる: 回の境目より前なので、2回目に取り込まれる
const judge = async (
  /** @type {{ messages: { user: { type: string }[] } }} */ llmCall,
  /** @type {number} */ n,
) => {
  if (n === 0)
    await call('POST', `/jobs/auto/${jobId}/interventions`, {
      kind: 'instruction',
      text: INSTRUCTION,
    });
  return {
    images: llmCall.messages.user
      .filter((part) => part.type === 'image')
      .map((_, i) => ({ score: 0.5 + n * 0.2 + i * 0.1, issues: n === 0 ? ['背景が暗い'] : [] })),
    nextChange: n === 0 ? 'もっと逆光にする' : '十分',
    canStop: n === 1,
  };
};

const runner = new JobRunner({
  store,
  // 止まったときの蒸留（口出しが材料になる）。何も覚えない最小の応答でも、呼び出しは回に属さない記録として残る
  llm: new ScriptedLlm({
    think,
    judge,
    'ref-gist': () => ({ gist: GIST }),
    distill: () => ({ operations: [] }),
  }),
  memory: {
    store: createFsMemoryStore(dataPaths(root).memory),
    distillLog: createFsDistillLog(root),
  },
  backend,
  budget: DEFAULT_BUDGET,
  permissions: basicPermissions({ width: 64, height: 64 }),
  now,
  newCallId,
});
app = createApi({
  backend,
  store,
  memoryStore: createFsMemoryStore(dataPaths(root).memory),
  manualRunner: new ManualGenerationRunner({ backend, store, now }),
  backendSettings: {
    read: () => Promise.reject(new Error('使わない')),
    write: () => Promise.reject(new Error('使わない')),
  },
  autoQueue: runner,
  budgetSettings: {
    read: async () => ({ overrides: {}, effective: resolveBudgets({}), invalid: [] }),
    write: async () => resolveBudgets({}),
  },
  progressPreviews: new ProgressPreviews(),
  generationProgressSettings: {
    read: async () => DEFAULT_GENERATION_PROGRESS_SETTINGS,
    write: async () => undefined,
  },
  permissionSettings: {
    base: basicPermissions({ width: 64, height: 64 }),
    read: async () => undefined,
    write: async () => undefined,
  },
  candidateNotes: { read: async () => ({ notes: new Map() }), write: async () => undefined },
  stopConditionParser: { parse: () => Promise.reject(new Error('使わない')) },
  llmSettings: { read: async () => undefined, write: async () => undefined },
  conversations: (() => {
    const conversationStore = new MemoryConversationStore();
    return { store: conversationStore, hubs: new ConversationHubs({ store: conversationStore }) };
  })(),
  env: {},
  now,
});

try {
  const reference = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#2266aa' },
  })
    .png()
    .toBuffer();
  const submitted = await call('POST', '/jobs/auto', {
    request: REQUEST,
    stopConditions: { aiJudgement: true, maxIterations: 2 },
    batchSize: 2,
    references: [
      { mediaType: 'image/png', data: reference.toString('base64'), note: 'この構図で' },
    ],
  });
  jobId = submitted.jobId;
  await runner.idle();

  // 壊れた記録を1つ置く: API が invalid として返す実物を取るため
  const llmCallsDir = join(dataPaths(root).jobFiles(jobId).llmCalls);
  await writeFile(join(llmCallsDir, `${BROKEN_CALL_ID}.json`), '{ "callId": ');

  const recorded = await call('GET', `/jobs/${jobId}/llm-calls`);
  // 読めない理由には一時ディレクトリの絶対パスが入り、毎回変わる。機械的に置き換える
  const calls = {
    ...recorded,
    invalid: recorded.invalid.map((/** @type {{ callId: string, reason: string }} */ item) => ({
      ...item,
      reason: item.reason.replaceAll(root, '<データディレクトリ>'),
    })),
  };
  const thinkCall = calls.calls.find(
    (/** @type {{ purpose: string }} */ c) => c.purpose === 'think',
  );
  const files = {
    'job.json': await call('GET', `/jobs/${jobId}`),
    'iterations.json': await call('GET', `/jobs/${jobId}/iterations`),
    'llm-calls.json': calls,
    'references.json': await call('GET', `/jobs/auto/${jobId}/references`),
    'interventions.json': await call('GET', `/jobs/auto/${jobId}/interventions`),
    'selections.json': await call('GET', `/jobs/${jobId}/selections`),
    'llm-call-think.json': await call('GET', `/jobs/${jobId}/llm-calls/${thinkCall.callId}`),
  };
  await mkdir(OUT, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    // リポジトリの整形に合わせて書く: 取り直しのたびに format:check が赤くならないように
    const path = join(OUT, name);
    const options = (await resolveConfig(path)) ?? {};
    await writeFile(path, await format(JSON.stringify(body), { ...options, filepath: path }));
  }
  console.log(`jobId: ${jobId}`);
  console.log(`llm-calls dir: ${(await readdir(llmCallsDir)).length} files`);
  console.log(`wrote: ${Object.keys(files).join(', ')} -> ${OUT}`);
} finally {
  await runner.idle();
  await rm(root, { recursive: true, force: true });
  process.exitCode ??= 0;
}
