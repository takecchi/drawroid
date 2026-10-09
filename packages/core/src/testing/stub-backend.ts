import {
  type BackendCapabilities,
  type Candidate,
  type CandidateKind,
  type GeneratedImage,
  type GenerationImages,
  type GenerationRequest,
  type GenerationResult,
  type ImageBackend,
  inputImageRefsOf,
} from '../backend.js';
import { BackendError } from '../backend-error.js';

// 1x1 の透明な PNG。中身を見る試験は無いので、PNG として読める最小のものにしてある
export const STUB_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

export const DEFAULT_STUB_CANDIDATES: Record<CandidateKind, Candidate[]> = {
  checkpoint: [{ name: 'stub-anime.safetensors', label: 'stub-anime' }, { name: 'stub-real' }],
  vae: [{ name: 'stub-vae.safetensors' }],
  lora: [{ name: 'stub-lora-a' }, { name: 'stub-lora-b' }],
  sampler: [{ name: 'Euler a' }, { name: 'DPM++ 2M' }],
  scheduler: [{ name: 'Automatic' }, { name: 'Karras' }],
  upscaler: [{ name: 'Latent' }, { name: 'R-ESRGAN 4x+' }],
  controlnetModel: [{ name: 'stub-canny [0123abcd]', label: 'stub-canny' }],
  controlnetModule: [{ name: 'canny' }, { name: 'depth' }],
};

export interface StubBackendOptions {
  candidates?: Partial<Record<CandidateKind, Candidate[]>>;
  capabilities?: BackendCapabilities;
  // 生成にかかる時間。走行中の停止を試すときに伸ばす
  generateDelayMs?: number;
}

// メモリの上だけで動くバックエンド。core・api・M2 以降のループの試験で、本物のバックエンドの代わりに使う
export class StubBackend implements ImageBackend {
  // generate が受け取った要求。試験は「何を頼んだか」をここで見る
  readonly requests: GenerationRequest[] = [];
  interruptCount = 0;
  private readonly candidates: Record<CandidateKind, Candidate[]>;
  private readonly capabilities: BackendCapabilities;
  private readonly generateDelayMs: number;
  private readonly pendingFailures: BackendError[] = [];
  private unreachable = false;
  private nextSeed = 1000;

  constructor(options: StubBackendOptions = {}) {
    this.candidates = { ...DEFAULT_STUB_CANDIDATES, ...options.candidates };
    this.capabilities = options.capabilities ?? { unavailable: [] };
    this.generateDelayMs = options.generateDelayMs ?? 0;
  }

  // 次の generate を、渡したエラーで失敗させる。複数回呼べば、その順に失敗させる
  failNextGenerate(error: BackendError): void {
    this.pendingFailures.push(error);
  }

  // 落ちているバックエンドとして振る舞わせる
  setUnreachable(unreachable: boolean): void {
    this.unreachable = unreachable;
  }

  async probe(signal?: AbortSignal): Promise<BackendCapabilities> {
    this.ensureCallable(signal);
    return structuredClone(this.capabilities);
  }

  async listCandidates(kind: CandidateKind, signal?: AbortSignal): Promise<Candidate[]> {
    this.ensureCallable(signal);
    return structuredClone(this.candidates[kind]);
  }

  async generate(
    req: GenerationRequest,
    signal: AbortSignal,
    inputs: GenerationImages = new Map(),
  ): Promise<GenerationResult> {
    this.ensureCallable(signal);
    const missing = inputImageRefsOf(req).filter((ref) => !inputs.has(ref));
    if (missing.length > 0) {
      throw new BackendError('failed', `画像の中身が渡されていない: ${missing.join(', ')}`);
    }
    this.requests.push(structuredClone(req));
    const failure = this.pendingFailures.shift();
    if (failure !== undefined) throw failure;
    await abortableDelay(this.generateDelayMs, signal);
    const firstSeed = req.seed ?? this.nextSeed++;
    const images: GeneratedImage[] = Array.from({ length: req.batchSize }, (_, i) => ({
      png: STUB_PNG.slice(),
      seed: firstSeed + i,
      metadata: { stub: true, index: i },
    }));
    return { images, metadata: { stub: true } };
  }

  async interrupt(): Promise<void> {
    this.interruptCount++;
  }

  private ensureCallable(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw abortedError();
    if (this.unreachable) throw new BackendError('unreachable', 'スタブのバックエンドは落ちている');
  }
}

function abortedError(): BackendError {
  return new BackendError('aborted', '呼び手が止めた');
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortedError());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
