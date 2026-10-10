import type {
  BudgetOverrides,
  Budgets,
  InvalidBudget,
  CandidateNotes,
  ConversationHubs,
  ConversationStore,
  GenerationProgressSettings,
  ImageBackend,
  InterventionRecord,
  JobStore,
  LlmRole,
  ManualGenerationRunner,
  MemoryStore,
  ModelWindow,
  MaskIntervention,
  NewMask,
  NewReference,
  Permissions,
  ProgressPreviews,
  ReferenceRecord,
  StopConditions,
  StopConditionsChange,
  DistillLog,
} from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';

import type { BackendSettingsPort } from './backend-settings.js';
import type { StopConditionParser } from './stop-condition-parse.js';

/** 自動ジョブの待ち行列。JobRunner をそのまま渡せる形にしてある */
export type AutoJobQueue = {
  kick(): void;
  stop(jobId: string): Promise<void>;
  /** 断るときは InterventionRejectedError を投げる */
  addInstruction(jobId: string, text: string): Promise<InterventionRecord>;
  /** 重ねたあとの実際の止める条件を返す。断るときは InterventionRejectedError を投げる */
  changeStopConditions(jobId: string, change: StopConditionsChange): Promise<StopConditions>;
  /** 断るときは InterventionRejectedError を投げる */
  addReference(jobId: string, reference: NewReference): Promise<ReferenceRecord>;
  /** 塗った画像があるかは呼び手が確かめる。断るときは InterventionRejectedError を投げる */
  addMask(jobId: string, mask: NewMask): Promise<MaskIntervention>;
  /**
   * 人間が選んだ画像を採らせる（JobRunner.adopt）。画像があるかは呼び手が確かめる。断るときは InterventionRejectedError を投げる。
   * 省けば、画面の「採る」ボタンは断られる（会話の adopt_image だけが採れる）
   */
  adopt?(jobId: string, image: { iteration: number; index: number }): Promise<InterventionRecord>;
};

export type LlmSettingsStore = {
  read(): Promise<unknown | undefined>;
  write(config: LlmConfig): Promise<void>;
};

/** config.json の permissions（全体の既定の許可のうち、書いたパラメータだけ） */
export type PermissionSettingsStore = {
  /** 設定に何も書かないときの土台。書いた欄はこれに重なる */
  base: Permissions;
  /** 無ければ undefined。中身は検証していない（人間が手で直したものを含む） */
  read(): Promise<unknown | undefined>;
  write(overrides: Partial<Permissions>): Promise<void>;
};

/** config.json の budgets（予算のうち、書いた欄だけ）。解決は既定に深く重ねる */
export type BudgetSettingsPort = {
  /**
   * overrides は読めた欄だけ。読めない欄は既定に戻し、invalid に道筋と理由を返す（許可と同じ作り）。
   * config.json そのものが読めないときは、理由を付けて投げる
   */
  read(): Promise<{ overrides: unknown; effective: Budgets; invalid: InvalidBudget[] }>;
  write(overrides: BudgetOverrides): Promise<Budgets>;
};

/** config.json の generationProgress。無ければ既定（途中の画像は流さない）。読めない設定は、理由を付けて投げる */
export type GenerationProgressSettingsPort = {
  read(): Promise<GenerationProgressSettings>;
  write(settings: GenerationProgressSettings): Promise<void>;
};

/** candidate-notes.json（候補の名前 → 人間の短い説明） */
export type CandidateNotesStore = {
  read(): Promise<CandidateNotes>;
  write(notes: Readonly<Record<string, string>>): Promise<void>;
};

/** 会話の置き場所とハブ。SSE のハートビートの時計も、試験で差し替えられるようにここで受ける */
export type ConversationsPort = {
  store: ConversationStore;
  hubs: ConversationHubs;
  /** beat を一定の間隔で呼び、止める関数を返す。省けば15秒ごと */
  heartbeat?: (beat: () => void) => () => void;
  /** 発言を受けたことを話す役の実行器へ知らせる。省けば発言を置くだけで、ターンは始めない */
  turns?: {
    kick(conversationId: string): void;
    /** 走っているターンを打ち切る。scope が all ならジョブも止める。走っているものが無ければ何もしない */
    interrupt(
      conversationId: string,
      scope: 'turn' | 'all',
    ): Promise<{ turn: boolean; job: string | undefined }>;
  };
};

/** drawroid doctor の確かめの1項目。ok でなければ、todo に何をすればよいかを書く */
export type DoctorItem = { ok: boolean; what: string; todo?: string };
export type DoctorSection = { title: string; items: DoctorItem[] };
/** lacking は ok でない項目の数 */
export type DoctorReport = { sections: DoctorSection[]; lacking: number };
/** 設定・バックエンド・LLM・web の配り先を一度に確かめる（drawroid doctor と同じ確かめ）。何も書き換えない。鍵の値は出さない */
export type DoctorPort = { run(): Promise<DoctorReport> };

export type ApiDeps = {
  backend: ImageBackend;
  store: JobStore;
  memoryStore: MemoryStore;
  manualRunner: ManualGenerationRunner;
  backendSettings: BackendSettingsPort;
  autoQueue: AutoJobQueue;
  /** 投入のときに解決した予算を、ジョブへ写すために読む。走行中のジョブには効かせない */
  budgetSettings: BudgetSettingsPort;
  /** 生成中の途中の画像を1枚だけ持つ置き場。ジョブ実行器の橋渡しが入れ、/progress-preview が読む */
  progressPreviews: ProgressPreviews;
  generationProgressSettings: GenerationProgressSettingsPort;
  llmSettings: LlmSettingsStore;
  stopConditionParser: StopConditionParser;
  permissionSettings: PermissionSettingsStore;
  candidateNotes: CandidateNotesStore;
  conversations: ConversationsPort;
  /** API キーの環境変数が入っているかを確かめるため。値は応答に出さない */
  env: Readonly<Record<string, string | undefined>>;
  /** 止まったジョブで選択が変わったときに、蒸留を裏で回す側へ知らせる。応答は待たない */
  reselection?: { notify(jobId: string): void };
  /** ジョブから覚えたこと（蒸留の記録）を読む。省けば、どのジョブも覚えたことが無いとして答える */
  distillLog?: Pick<DistillLog, 'read'>;
  /** 設定の画面の「確かめる」。省けば、画面からは確かめられない（409） */
  doctor?: DoctorPort;
  /**
   * 予算と比べる、役ごとの窓。llm を渡せばその設定の、省けばいま効いている設定の、分かっている窓だけを返す
   * （分からない役は返さない。知らせるのは返す側）。省けば、保存のときに予算と窓を比べない
   */
  inputWindows?: (llm?: LlmConfig) => Promise<Partial<Record<LlmRole, ModelWindow>>>;
  now?: () => Date;
};
