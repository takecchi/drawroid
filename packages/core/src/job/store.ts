import type { LlmCallRecord } from '../llm/record.js';
import type { PreviewImage } from '../loop/inputs.js';
import type { GeneratedImage } from '../backend.js';
import type {
  InterventionRecord,
  JobSpec,
  JobState,
  NewIntervention,
  NewJobSpec,
} from './types.js';

/** 回の中の段の出力。ファイルがあることが、その段が済んだことを表す */
export type StageName = 'think' | 'request' | 'judge';

export type ImageRef = { jobId: string; iteration: number; index: number };

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

  /** 段の出力が無ければ undefined */
  readStage(jobId: string, iteration: number, stage: StageName): Promise<unknown>;
  writeStage(jobId: string, iteration: number, stage: StageName, value: unknown): Promise<void>;

  /** 生成された画像（原寸）とバックエンドのメタデータを置く */
  saveImages(jobId: string, iteration: number, images: readonly GeneratedImage[]): Promise<void>;

  /**
   * LLM に渡す縮小版を返す。無ければ原寸から作って置く。渡した印があれば sentInCall に入る。
   */
  loadPreview(image: ImageRef, longEdge: number): Promise<PreviewImage>;
  /** この画像を渡した呼び出しを記録する（渡した印） */
  markSent(image: ImageRef, callId: string, now: Date): Promise<void>;

  /** jobId が null の記録は、ジョブに属さない置き場へ置く */
  writeLlmCall(record: LlmCallRecord): Promise<void>;
  /** 呼び出しの順（＝ callId の順） */
  listLlmCalls(jobId: string | null): Promise<LlmCallRecord[]>;
}
