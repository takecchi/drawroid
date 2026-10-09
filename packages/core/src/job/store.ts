import type { GenerationRequest, GenerationResult } from '../backend.js';
import type { LlmCallRecord } from '../llm/record.js';
import type { PreviewImage } from '../loop/inputs.js';
import type { InterventionRecord, JobSpec, JobState, NewIntervention } from './types.js';

export type ImageRef = { jobId: string; iteration: number; index: number };

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
  createJob(spec: NewJobSpec, state: JobState, now: Date): Promise<JobSpec>;
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

  /**
   * LLM に渡す縮小版を返す。無ければ原寸から作って置く。渡した印があれば sentInCall に入る。
   */
  loadPreview(image: ImageRef, longEdge: number): Promise<PreviewImage>;
  /** この画像を渡した呼び出しを記録する（渡した印） */
  markSent(image: ImageRef, callId: string, now: Date): Promise<void>;

  /** jobId が null の記録は、ジョブに属さない置き場へ置く */
  writeLlmCall(record: LlmCallRecord): Promise<void>;
  /** 呼び出しの順（＝ callId の順）。1つでも読めなければ失敗する（ループの内部向け） */
  listLlmCalls(jobId: string | null): Promise<LlmCallRecord[]>;
  /** 画面向けに、読めないファイルを外して理由を返す。listLlmCalls は1件の破損で全体が失敗するので、閲覧には使えない */
  listLlmCallRecords(jobId: string): Promise<{
    records: LlmCallRecord[];
    invalid: { callId: string; reason: string }[];
  }>;
  /** 回のディレクトリがある回の番号を昇順で返す。回のディレクトリは think を書いた時点でできる */
  listIterations(jobId: string): Promise<number[]>;
}
