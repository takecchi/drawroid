import type {
  BudgetOverrides,
  Budgets,
  CandidateNotes,
  ConversationHubs,
  ConversationStore,
  GenerationProgressSettings,
  ImageBackend,
  InterventionRecord,
  JobStore,
  ManualGenerationRunner,
  MemoryStore,
  MaskIntervention,
  NewMask,
  NewReference,
  Permissions,
  ProgressPreviews,
  ReferenceRecord,
  StopConditions,
  StopConditionsChange,
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
  /** overrides は検証していない（人間が手で直したものを含む）。読めない設定は、理由を付けて投げる */
  read(): Promise<{ overrides: unknown; effective: Budgets }>;
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
  turns?: { kick(conversationId: string): void };
};

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
  now?: () => Date;
};
