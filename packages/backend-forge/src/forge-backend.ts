import { interruptGeneration, readProgress } from '@drawroid/backend-sdapi';
import type {
  BackendCapabilities,
  Candidate,
  CandidateKind,
  GenerationImages,
  GenerationProgress,
  GenerationRequest,
  GenerationResult,
  ImageBackend,
} from '@drawroid/core';

import { listForgeCandidates } from './candidates.js';
import { ForgeClient } from './client.js';
import { generateWithForge } from './generate.js';
import { probeForge } from './probe.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// 生成は同期の HTTP で、チェックポイントの切り替えを含むと数分かかりうる
export const DEFAULT_GENERATE_TIMEOUT_MS = 10 * 60_000;

export interface ForgeBackendOptions {
  baseUrl: string;
  auth?: { username: string; password: string };
  requestTimeoutMs?: number;
  generateTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class ForgeBackend implements ImageBackend {
  private readonly client: ForgeClient;
  private readonly generateTimeoutMs: number;

  constructor(options: ForgeBackendOptions) {
    this.client = new ForgeClient({
      baseUrl: options.baseUrl,
      timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ...(options.auth !== undefined && { auth: options.auth }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    });
    this.generateTimeoutMs = options.generateTimeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
  }

  probe(signal?: AbortSignal): Promise<BackendCapabilities> {
    return probeForge(this.client, signal);
  }

  listCandidates(kind: CandidateKind, signal?: AbortSignal): Promise<Candidate[]> {
    return listForgeCandidates(this.client, kind, signal);
  }

  generate(
    req: GenerationRequest,
    signal: AbortSignal,
    images?: GenerationImages,
  ): Promise<GenerationResult> {
    return generateWithForge(this.client, req, {
      signal,
      timeoutMs: this.generateTimeoutMs,
      ...(images !== undefined && { images }),
    });
  }

  async interrupt(): Promise<void> {
    await interruptGeneration(this.client);
  }

  // 待つ上限は client の既定（requestTimeoutMs）のまま: 進み具合は短く答えるはずの問い合わせで、生成の上限を渡すと止まった生成を長く待ってしまうため
  progress(
    signal: AbortSignal,
    options?: { includePreview?: boolean },
  ): Promise<GenerationProgress | undefined> {
    return readProgress(this.client, signal, options);
  }
}
