import type { GenerationRequest, GenerationResult } from '../backend.js';
import type { LlmCallRecord } from '../llm/record.js';
import type { PreviewImage } from '../loop/inputs.js';
import type { SelectionRecord } from '../selection/selection.js';
import type {
  InterventionRecord,
  JobSpec,
  JobState,
  NewIntervention,
  NewReference,
  ReferenceRecord,
} from './types.js';

export type ImageRef = { jobId: string; iteration: number; index: number };
/** 人間が添えた参照画像 */
export type ReferenceImageRef = { jobId: string; refId: string };
// ImageRef に kind を足して判別しない: 生成された画像を指す既存の呼び出し側を、すべて書き換えることになるため
export type AnyImageRef = ImageRef | ReferenceImageRef;

export function isReferenceImageRef(image: AnyImageRef): image is ReferenceImageRef {
  return 'refId' in image;
}

/** 回の中の LLM の段の出力。ファイルがあることが、その段が済んだことを表す（生成の段は writeGeneration の request） */
export type StageName = 'think' | 'judge';

// Omit は union に効かず分岐ごとの欄が消えるため、型引数に取って分岐ごとに外す
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewJobSpec = DistributiveOmit<JobSpec, 'jobId' | 'createdAt'>;

export type StoredGeneration = {
  iteration: number;
  request: GenerationRequest;
  images: { index: number; seed: number | null }[];
};

/** ジョブの置き場所。core はファイルの置き方を知らず、この口だけを使う */
export interface JobStore {
  /** job.json と、待ち行列に入った state.json を置く。jobId は置き場所が決める */
  createJob(
    spec: NewJobSpec,
    state: JobState,
    now: Date,
    /** 依頼に添える参照画像。ジョブが一覧に見える前に置く */
    references?: readonly NewReference[],
  ): Promise<JobSpec>;
  /** 作成順（＝ jobId の順） */
  listJobIds(): Promise<string[]>;
  readJob(jobId: string): Promise<JobSpec>;
  writeJob(spec: JobSpec): Promise<void>;
  readState(jobId: string): Promise<JobState>;
  writeState(jobId: string, state: JobState): Promise<void>;

  /** 口出しを置く。interventionId は置き場所が決め、その名前の順が受けた順になる */
  addIntervention(
    jobId: string,
    intervention: NewIntervention,
    now: Date,
  ): Promise<InterventionRecord>;
  /** 受けた順 */
  listInterventions(jobId: string): Promise<InterventionRecord[]>;
  /** 人間の指示を「考える」に取り込んだ回を書き戻す。原文には触れない */
  markInterventionApplied(jobId: string, interventionId: string, iteration: number): Promise<void>;

  /** 画像とそのメタデータを置いてから request を置く。request があることが、その回の生成と保存が済んだことを表す */
  writeGeneration(
    jobId: string,
    iteration: number,
    request: GenerationRequest,
    result: GenerationResult,
  ): Promise<void>;
  /** 生成と保存が済んだ回だけを、回の順に返す */
  listGenerations(jobId: string): Promise<StoredGeneration[]>;
  /** その回の生成と保存が済んでいなければ undefined */
  readGeneration(jobId: string, iteration: number): Promise<StoredGeneration | undefined>;
  /** 無ければ undefined */
  readImage(image: ImageRef): Promise<Uint8Array | undefined>;

  /** 段の出力が無ければ undefined */
  readStage(jobId: string, iteration: number, stage: StageName): Promise<unknown>;
  writeStage(jobId: string, iteration: number, stage: StageName, value: unknown): Promise<void>;

  /** 回の画像への人間の最終選択を置く（selections/<imageKey>.json）。同じ画像には上書きする */
  writeSelection(jobId: string, selection: SelectionRecord): Promise<void>;
  /** 無ければ undefined */
  readSelection(jobId: string, imageKey: string): Promise<SelectionRecord | undefined>;
  /** そのジョブの選択すべて（順は決めない） */
  listSelections(jobId: string): Promise<SelectionRecord[]>;

  /** 人間が添えた参照画像を refs/ に置く。refId は置き場所が決め、その名前の順が受けた順になる */
  addReference(jobId: string, reference: NewReference, now: Date): Promise<ReferenceRecord>;
  /** 受けた順 */
  listReferences(jobId: string): Promise<ReferenceRecord[]>;
  /** 見る役が書いた参照画像の要点を残す */
  writeReferenceGist(jobId: string, refId: string, gist: string): Promise<void>;

  /**
   * LLM に渡す縮小版を返す。無ければ原寸から作って置く。渡した印があれば sentInCall に入る。
   */
  loadPreview(image: AnyImageRef, longEdge: number): Promise<PreviewImage>;
  /** この画像を渡した呼び出しを記録する（渡した印） */
  markSent(image: AnyImageRef, callId: string, now: Date): Promise<void>;

  /** jobId が null の記録は、ジョブに属さない置き場へ置く */
  writeLlmCall(record: LlmCallRecord): Promise<void>;
  /** 呼び出しの順（＝ callId の順） */
  listLlmCalls(jobId: string | null): Promise<LlmCallRecord[]>;
}
