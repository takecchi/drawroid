import {
  generationRequestSchema,
  type GenerationRequest,
  type ImageBackend,
  inputImageRefsOf,
} from '../backend.js';
import { isBackendError } from '../backend-error.js';
import type { JobStore } from './store.js';
import type { StopReason } from './types.js';

/**
 * 手動の生成で受け付ける要求。元画像・マスク・ControlNet の画像を指すものは断る。
 */
// 受け付けてから生成で失敗させない: 手動の生成には画像の参照を中身に変える仕組みがまだ無く、
// 受け付けるとジョブを作ってから必ず失敗するため。入口で断れば、ジョブを作らずに 400 で返せる
export const manualGenerationRequestSchema = generationRequestSchema.refine(
  (req) => inputImageRefsOf(req).length === 0,
  {
    message: '手動の生成は、まだ img2img・inpaint・ControlNet（画像を指す欄）を受け付けない',
  },
);

export interface ManualGenerationRunnerOptions {
  backend: ImageBackend;
  store: JobStore;
  now?: () => Date;
}

// パラメータを明示して1回だけ生成する。AI のループは通らない
export class ManualGenerationRunner {
  private readonly backend: ImageBackend;
  private readonly store: JobStore;
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();

  constructor({ backend, store, now = () => new Date() }: ManualGenerationRunnerOptions) {
    this.backend = backend;
    this.store = store;
    this.now = now;
  }

  /** 検証に通らなければ ZodError を投げ、ジョブは作らない。生成は待たずに返る */
  async start(input: unknown): Promise<{ jobId: string }> {
    const request = manualGenerationRequestSchema.parse(input);
    const spec = await this.store.createJob(
      { kind: 'manual', request },
      { status: 'queued' },
      this.now(),
    );
    // 鎖につなぐ: バックエンドは1度に1つしか生成できず、並べて投げると後の依頼が先の生成を壊すため
    this.tail = this.tail.then(() => this.run(spec.jobId, request));
    return { jobId: spec.jobId };
  }

  /** いま受けているジョブがすべて止まるまで待つ */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.tail;
      await seen;
    } while (seen !== this.tail);
  }

  private async run(jobId: string, request: GenerationRequest): Promise<void> {
    const startedAt = this.now().toISOString();
    let imagesGenerated = 0;
    let reason: StopReason;
    try {
      await this.store.writeState(jobId, { status: 'running', startedAt, imagesGenerated });
      const result = await this.backend.generate(request, new AbortController().signal);
      await this.store.writeGeneration(jobId, 1, request, result);
      imagesGenerated = result.images.length;
      reason = { kind: 'limit:iterations', detail: '手動の生成は1回で止まる' };
    } catch (error) {
      reason = {
        kind: 'error',
        detail: error instanceof Error ? error.message : String(error),
        ...(isBackendError(error) && { backendErrorKind: error.kind }),
      };
    }
    try {
      await this.store.writeState(jobId, {
        status: 'stopped',
        startedAt,
        stoppedAt: this.now().toISOString(),
        imagesGenerated,
        reason,
      });
    } catch {
      // 止まった印すら書けないときは、ここで投げない: 鎖が rejected のままになり、後続のジョブが走らず、未処理の rejection にもなるため。state が running のまま残ることで異常が見える
    }
  }
}
