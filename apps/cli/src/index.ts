#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activeJobOfConversation,
  backfillJobEvents,
  bridgeJobEvents,
  closeInterruptedTurns,
  relayJobHeld,
  relayJobReasoning,
  ConversationHubs,
  conversationMessagesFor,
  createDrawingTools,
  createMemoryTools,
  createReadOnlyTools,
  createReviewTools,
  DEFAULT_BUDGET,
  jobSummaryFor,
  ManualGenerationRunner,
  mergePermissions,
  readDrawingStopConditions,
  ReselectionDistiller,
  TalkRunner,
} from '@drawroid/core';
import { detectContextTokens, llmConfigSchema, type LlmConfig } from '@drawroid/llm';
import {
  createFsDistillLog,
  createFsMemoryStore,
  FsConversationStore,
  dataPaths,
  FsJobStore,
  initDataDir,
  readCandidateNotes,
  readConversationSettings,
  readLlmSettings,
  readPermissionSettings,
  resolveDataDir,
  writeCandidateNotes,
  writePermissionSettings,
} from '@drawroid/storage-fs';

import { parseCliArgs } from './args.js';
import { AutoJobQueue, BASE_PERMISSIONS } from './auto-job-queue.js';
import { BACKEND_LABELS, backendFactory } from './backend-factory.js';
import { backendOptions, createBackendSettings } from './backend-settings.js';
import { createBudgetSettings } from './budget-settings.js';
import { createGenerationProgressSettings } from './generation-progress-settings.js';
import { readConfig, resolveBackendKind, resolveBackendUrlWithSource } from './config.js';
import { listen } from './listen.js';
import { createLlmSettings } from './llm-settings.js';
import { createPermissionReader } from './permission-reader.js';
import { wireGenerationProgress } from './progress-wiring.js';
import { ReplaceableBackend } from './replaceable-backend.js';
import { createStopConditionParser } from './stop-condition-parser.js';
import { pickWebRoot } from './web-root.js';

// tsc の出力（dist）へは apps/web の成果物を写さず、依存として解決した場所から配る: 写すと前回のビルドの古いファイルが dist に残り続けるため。
// 隣の web/ を先に見るのは配布用の bundle だけで、そちらは scripts/bundle.mjs が写す前に写し先を空にする
function resolveWebRoot(): string {
  return pickWebRoot(join(dirname(fileURLToPath(import.meta.url)), 'web'), () => {
    const webPackageJson = createRequire(import.meta.url).resolve('@drawroid/web/package.json');
    return join(dirname(webPackageJson), 'build', 'client');
  });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const root = resolveDataDir({ cliArg: args.dataDir, env: process.env.DRAWROID_HOME });
  const { sweptTempFiles } = await initDataDir(root);
  process.stdout.write(`drawroid: データディレクトリ ${root}\n`);
  if (sweptTempFiles.length > 0) {
    process.stdout.write(
      `drawroid: 前回の書きかけの一時ファイルを ${sweptTempFiles.length} 個片付けた\n`,
    );
  }

  // どのアダプタを使うかを決めるのは、組み立ての根であるここだけ
  const configPath = dataPaths(root).config;
  const config = await readConfig(configPath);
  const kind = resolveBackendKind(args.backend, config);
  const { url, source } = resolveBackendUrlWithSource(args.backendUrl, config);
  const createBackend = backendFactory(kind);
  const backend = new ReplaceableBackend(createBackend(backendOptions(url, config.backend)));
  const backendSettings = createBackendSettings({
    configPath,
    backend,
    createBackend,
    initial: { kind, url, source, config },
  });
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const conversationStore = new FsConversationStore(root);
  const conversationHubs = new ConversationHubs({ store: conversationStore });
  // ジョブの置き場所を橋渡しで包む: 会話から作ったジョブの段が、会話のログに出るように
  const store = bridgeJobEvents(new FsJobStore(root), {
    hubs: conversationHubs,
    onError: (error) =>
      log(
        `drawroid: ジョブの段を会話に書けなかった（ジョブは続ける）: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  const manualRunner = new ManualGenerationRunner({ backend, store });
  process.stdout.write(`drawroid: ${BACKEND_LABELS[kind]} ${url}\n`);

  // 自動ジョブを再開する前・話す役を立てる前に、落ちる前の会話を整える: 途切れたターンを閉じ、
  // 段のファイルはあるのに会話に出ていないジョブのイベントを書き足す
  const closedTurns = await closeInterruptedTurns({
    store: conversationStore,
    hubs: conversationHubs,
  });
  if (closedTurns > 0) log(`drawroid: 再起動で途切れた会話のターンを閉じた: ${closedTurns}`);
  const backfilled = await backfillJobEvents({
    jobs: store,
    conversations: conversationStore,
    hubs: conversationHubs,
  });
  if (backfilled > 0)
    log(`drawroid: 会話に出ていなかったジョブのイベントを書き足した: ${backfilled}`);

  const memoryStore = createFsMemoryStore(dataPaths(root).memory);
  const readPermissions = createPermissionReader(() => readPermissionSettings(configPath), log);
  // 起動のときに一度読む: 読めない行があれば、ジョブを待たずにログで知らせる
  await readPermissions();
  const progress = wireGenerationProgress({
    backend,
    hubs: conversationHubs,
    settings: createGenerationProgressSettings(configPath),
    onError: (error) =>
      log(
        `drawroid: 生成の進み具合を読めなかった（生成は続ける）: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  const autoQueue = new AutoJobQueue({
    store,
    backend,
    env: process.env,
    budget: DEFAULT_BUDGET,
    // 回の境目ごとに config.json を読み直す: API で変えた許可を、再起動せずに走行中のジョブの次の回から効かせるため
    permissions: readPermissions,
    candidateNotes: () => readCandidateNotes(dataPaths(root).candidateNotes),
    memory: {
      store: memoryStore,
      distillLog: createFsDistillLog(root),
      conversationMessages: conversationMessagesFor(conversationStore),
    },
    generationProgress: progress.generationProgress,
    // 会話に属するジョブの、考える役・見る役の思考の増分を、その会話へ流す
    onReasoning: relayJobReasoning({ store, hubs: conversationHubs }),
    // 話す役のターンがジョブの LLM の段を待たせている間、会話へ確定しない job.held を流す
    onLlmStagesHeld: relayJobHeld({
      store,
      hubs: conversationHubs,
      onError: (error) =>
        log(
          `drawroid: job.held を会話へ流せなかった: ${error instanceof Error ? error.message : String(error)}`,
        ),
    }),
    log,
  });
  // 窓の長さは保存せず、設定を効かせるたびに読む: LLM 側で窓を変えたら、drawroid の設定を書き直さずに追従させるため
  const configureLlm = async (llm: LlmConfig) => {
    const { config, detected } = await detectContextTokens(llm, { env: process.env });
    for (const { role, contextTokens } of detected) {
      log(`drawroid: ${role} の役の文脈の上限を LLM から読んだ: ${contextTokens}`);
    }
    autoQueue.configure(config);
  };
  const stored = await readLlmSettings(configPath);
  if (stored === undefined) {
    log(
      'drawroid: LLM が未設定。画面の「設定」の「LLM の設定」（/settings#llm）か PUT /api/settings/llm で設定するまで、自動ジョブは待ち行列に留まる',
    );
  } else {
    const parsed = llmConfigSchema.safeParse(stored);
    if (parsed.success) {
      await configureLlm(parsed.data);
    } else {
      log(
        `drawroid: config.json の llm が不正なので未設定のまま進む: ${parsed.error.issues[0]?.message ?? ''}`,
      );
    }
  }
  // 落ちる前の自動ジョブを再開する
  autoQueue.kick();
  const reselection = new ReselectionDistiller({
    store,
    memory: memoryStore,
    log: createFsDistillLog(root),
    llm: () => autoQueue.currentLlm(),
    onError: (error) =>
      log(
        `drawroid: 選び直しの蒸留に失敗した: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  const llmSettings = createLlmSettings({
    configPath,
    configure: configureLlm,
    kick: () => autoQueue.kick(),
    log,
  });

  const budgetSettings = createBudgetSettings(configPath);
  const readCandidates = () => readCandidateNotes(dataPaths(root).candidateNotes);
  const humanPermissions = async () => mergePermissions(BASE_PERMISSIONS, await readPermissions());
  // 話す役。LLM は自動ジョブと同じ設定（役 talk、省けば考える役）を使う
  const talkRunner = new TalkRunner({
    store: conversationStore,
    hubs: conversationHubs,
    llm: () => autoQueue.currentLlm(),
    tools: [
      ...createReadOnlyTools({
        backend,
        permissions: humanPermissions,
        candidateNotes: async () => (await readCandidates()).notes,
        memory: memoryStore,
        jobs: store,
      }),
      ...createDrawingTools({
        jobs: store,
        runner: autoQueue,
        conversations: conversationStore,
        humanPermissions,
        // 読めなければ候補が無いとして扱う: 広げる側には倒れない（候補の外の値で固定する引数は断られる）
        candidateNames: async (kind) =>
          (await backend.listCandidates(kind).catch(() => [])).map((candidate) => candidate.name),
        // 描き始める前に、軽い問い合わせ1回（checkpoint の一覧）で繋がるかを確かめる
        checkBackend: async (signal) => {
          await backend.listCandidates('checkpoint', signal);
        },
        defaultStopConditions: async () => {
          const read = readDrawingStopConditions(await readConversationSettings(configPath));
          if (read.problem !== undefined) log(`drawroid: ${read.problem}。既定の止める条件を使う`);
          return read.conditions;
        },
        // 投入の口と同じく、作るときに1度だけ読んでジョブへ写す
        budgets: async () => (await budgetSettings.read()).effective,
        now: () => new Date(),
      }),
      // 見る役を呼ぶ: 自動ジョブと同じ LLM・同じ記憶・同じ記録の口
      ...createReviewTools({
        jobs: store,
        llm: () => autoQueue.currentLlm(),
        budgets: async () => (await budgetSettings.read()).effective,
        memory: memoryStore,
      }),
      ...createMemoryTools({ memory: memoryStore, now: () => new Date() }),
    ],
    // 会話のジョブ: 発言のあいだ LLM の段を待たせる・人間の中断（all）で止める
    jobs: {
      active: (conversationId) => activeJobOfConversation(store, conversationId),
      hold: (jobId) => autoQueue.holdLlmStages(jobId),
      stop: (jobId) => autoQueue.stop(jobId),
    },
    jobSummary: jobSummaryFor({
      jobs: store,
      chars: async () => (await budgetSettings.read()).effective.talk.jobChars,
    }),
    // ターンの始めに読み直す: 画面で直した予算を、再起動せずに次のターンから効かせるため
    limits: async () => (await budgetSettings.read()).effective.talk,
    log,
  });
  const { address } = await listen({
    port: args.port,
    webRoot: resolveWebRoot(),
    deps: {
      backend,
      store,
      manualRunner,
      backendSettings,
      memoryStore,
      autoQueue,
      reselection,
      budgetSettings,
      ...progress.api,
      llmSettings,
      stopConditionParser: createStopConditionParser({
        store,
        currentLlm: () => autoQueue.currentLlm(),
      }),
      permissionSettings: {
        base: BASE_PERMISSIONS,
        read: () => readPermissionSettings(configPath),
        write: (overrides) => writePermissionSettings(configPath, overrides),
      },
      conversations: {
        store: conversationStore,
        hubs: conversationHubs,
        turns: talkRunner,
      },
      candidateNotes: {
        read: () => readCandidateNotes(dataPaths(root).candidateNotes),
        write: (notes) => writeCandidateNotes(dataPaths(root).candidateNotes, notes),
      },
      env: process.env,
    },
  });
  process.stdout.write(`drawroid: http://${address.address}:${address.port}/\n`);
}

main().catch((error: unknown) => {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'EADDRINUSE') {
    process.stderr.write('drawroid: ポートが既に使われている。--port で別のポートを指定する\n');
  } else {
    process.stderr.write(`drawroid: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
