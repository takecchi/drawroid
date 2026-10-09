import type {
  Budget,
  CandidateNotes,
  ImageBackend,
  InterventionRecord,
  JobStore,
  ManualGenerationRunner,
  MaskIntervention,
  NewMask,
  NewReference,
  Permissions,
  ReferenceRecord,
  StopConditions,
  StopConditionsChange,
} from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';

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

/** candidate-notes.json（候補の名前 → 人間の短い説明） */
export type CandidateNotesStore = {
  read(): Promise<CandidateNotes>;
  write(notes: Readonly<Record<string, string>>): Promise<void>;
};

export type ApiDeps = {
  backend: ImageBackend;
  store: JobStore;
  manualRunner: ManualGenerationRunner;
  autoQueue: AutoJobQueue;
  /** 自動ジョブの依頼を要約へ切り詰めるときの予算 */
  budget: Budget;
  llmSettings: LlmSettingsStore;
  permissionSettings: PermissionSettingsStore;
  candidateNotes: CandidateNotesStore;
  /** API キーの環境変数が入っているかを確かめるため。値は応答に出さない */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
};
