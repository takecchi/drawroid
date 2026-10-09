import { generationRequestSchema, type GenerationRequest, type ImageBackend } from '../backend.js';
import { isBackendError } from '../backend-error.js';
import type { JobStore } from './store.js';
import type { StopReason } from './types.js';

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
    const request = generationRequestSchema.parse(input);
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
