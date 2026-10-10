import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
  describeInputOverflow,
  findInputOverflows,
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
  writeCandidateNotes,
  writePermissionSettings,
} from '@drawroid/storage-fs';

import type { CliOptions } from './args.js';
import { AutoJobQueue, BASE_PERMISSIONS } from './auto-job-queue.js';
import { BACKEND_LABELS, backendFactory } from './backend-factory.js';
import { backendOptions, createBackendSettings } from './backend-settings.js';
import { createBudgetSettings } from './budget-settings.js';
import { createGenerationProgressSettings } from './generation-progress-settings.js';
import { readConfig, resolveBackendKind, resolveBackendUrlWithSource } from './config.js';
import { createInputWindows } from './input-windows.js';
import { listen, type Listening } from './listen.js';
import { screenDoctor } from './doctor.js';
import { logFailedJobs } from './failure-log.js';
import { createLlmSettings } from './llm-settings.js';
import { createPermissionReader } from './permission-reader.js';
import { wireGenerationProgress } from './progress-wiring.js';
import { ReplaceableBackend } from './replaceable-backend.js';
import { shutdownHandler, type ShutdownSignal } from './shutdown.js';
import { createStopConditionParser } from './stop-condition-parser.js';
import { resolveWebRoot } from './web-root.js';

export interface AssembleOptions {
  /** データディレクトリ */
  root: string;
  args: Pick<CliOptions, 'port' | 'backend' | 'backendUrl'>;
  env: NodeJS.ProcessEnv;
  /** 止める合図を受ける口（本番は process） */
  signals: { on(signal: ShutdownSignal, handler: () => void): unknown };
  /** 終わる口（本番は process.exit） */
  exit: (code: number) => void;
  /** 起動の知らせを書く口（本番は標準出力） */
  write: (text: string) => void;
  /** 配る画面の置き場所。省けば固めた drawroid の中を探す */
  webRoot?: string;
}

/**
 * drawroid を組み立てて、HTTP の口を開く（doctor 以外の起動）。index.ts の main はこれを呼ぶだけ。
 * 試験から呼べるように、process の口（標準出力・環境変数・合図・終わり方）を引数で受ける
 */
// 組み立ての順を変えない: 途切れたターンを閉じて書き足してから話す役を立て、話す役を立ててからジョブを再開する。
// 順を崩すと、落ちる前の止まりで話しかけ直したり、再開したジョブの止まりが話す役に届かなかったりするため
export async function assembleDrawroid({
  root,
  args,
  env,
  signals,
  exit,
  write,
  webRoot,
}: AssembleOptions): Promise<Listening> {
  const { sweptTempFiles } = await initDataDir(root);
  write(`drawroid: データディレクトリ ${root}\n`);
  if (sweptTempFiles.length > 0) {
    write(`drawroid: 前回の書きかけの一時ファイルを ${sweptTempFiles.length} 個片付けた\n`);
  }

  // 待ち受ける drawroid がどのアダプタを使うかを決めるのは、組み立ての根であるここだけ（drawroid doctor は自分の引数と config.json で別に決める）
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
  const log = (line: string) => write(`${line}\n`);
  const shutdown = shutdownHandler({ backend, log, exit });
  signals.on('SIGINT', () => void shutdown('SIGINT'));
  signals.on('SIGTERM', () => void shutdown('SIGTERM'));
  const conversationStore = new FsConversationStore(root);
  const conversationHubs = new ConversationHubs({ store: conversationStore });
  // ジョブの置き場所を橋渡しで包む: 会話から作ったジョブの段が、会話のログに出るように
  // 失敗で止まったジョブは、会話に属するかに関わらず端末に1行出す
  const store = bridgeJobEvents(logFailedJobs(new FsJobStore(root), log), {
    hubs: conversationHubs,
    onError: (error) =>
      log(
        `drawroid: ジョブの段を会話に書けなかった（ジョブは続ける）: ${error instanceof Error ? error.message : String(error)}`,
      ),
    // 会話のジョブが止まったら、話す役から話しかける。ジョブを回し始めるのは talkRunner を作ったあと（下の autoQueue.kick）
    onStopped: (stop) => talkRunner.reportJobStopped(stop),
  });
  const manualRunner = new ManualGenerationRunner({ backend, store });
  write(`drawroid: ${BACKEND_LABELS[kind]} ${url}\n`);
  const servedWebRoot = webRoot ?? resolveWebRoot();
  if (!existsSync(join(servedWebRoot, 'index.html'))) {
    write(
      'drawroid: web の build が無いので、画面は http://localhost:5173/（開発中）か、pnpm build のあとで配る\n',
    );
  }

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
    env,
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
  // いま効いている LLM の設定（LLM から読んだ窓を埋めたもの）。予算の保存で、窓と比べるために持つ
  let configuredLlm: LlmConfig | undefined;
  const inputWindows = createInputWindows({ current: () => configuredLlm, log });
  // 窓の長さは保存せず、設定を効かせるたびに読む: LLM 側で窓を変えたら、drawroid の設定を書き直さずに追従させるため
  const configureLlm = async (llm: LlmConfig) => {
    const { config, detected } = await detectContextTokens(llm, { env });
    for (const { role, contextTokens } of detected) {
      log(`drawroid: ${role} の役の文脈の上限を LLM から読んだ: ${contextTokens}`);
    }
    configuredLlm = config;
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

  const budgetSettings = createBudgetSettings(configPath, log);
  // 起動のときに一度読む: 読めない欄があれば、投入を待たずにログで知らせる
  const startingBudgets = await budgetSettings.read();
  // 予算の欄ごとの上限の和が窓に入らなければ知らせる。起動は止めない: 予算か LLM の設定を、画面から直せるようにするため
  if (configuredLlm !== undefined) {
    const overflows = findInputOverflows(startingBudgets.effective, await inputWindows());
    if (overflows.length > 0) {
      log(
        `drawroid: 予算が窓に入らない（ジョブは入力を組む段で止まる）: ${overflows.map(describeInputOverflow).join('。')}`,
      );
    }
  }
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
  // 落ちる前の自動ジョブを再開する。talkRunner を作ってから回す: 再開したジョブが止まったときに、橋渡しが話す役へ知らせるため
  autoQueue.kick();
  return listen({
    port: args.port,
    webRoot: servedWebRoot,
    deps: {
      backend,
      store,
      manualRunner,
      backendSettings,
      memoryStore,
      autoQueue,
      reselection,
      budgetSettings,
      inputWindows,
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
      env,
      // 止まりのカードの「このジョブから覚えたこと」。読むだけ（書くのは自動ジョブと選び直しの蒸留）
      distillLog: createFsDistillLog(root),
      doctor: screenDoctor({
        configPath,
        backendSettings,
        env,
        webRoot: resolveWebRoot,
      }),
    },
  });
}
