import type { GenerationRequest, GenerationResult } from '../backend.js';
import type { JobSpec, JobState } from './types.js';

export type ImageRef = { jobId: string; iteration: number; index: number };

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

  /** 画像とそのメタデータを置いてから request を置く。request があることが、その回の生成と保存が済んだことを表す */
  writeGeneration(
    jobId: string,
    iteration: number,
    request: GenerationRequest,
    result: GenerationResult,
  ): Promise<void>;
  /** 生成と保存が済んだ回だけを、回の順に返す */
  listGenerations(jobId: string): Promise<StoredGeneration[]>;
  /** 無ければ undefined */
  readImage(image: ImageRef): Promise<Uint8Array | undefined>;
}
