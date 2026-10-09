import type {
  BackendCapabilities,
  Candidate,
  CandidateKind,
  GenerationRequest,
  GenerationResult,
  ImageBackend,
} from '@drawroid/core';

// 起動したまま Forge の URL を変えられるようにする入れ物。ManualGenerationRunner などが握るのはこの入れ物で、中身だけが替わる
export class ReplaceableBackend implements ImageBackend {
  private current: ImageBackend;

  constructor(initial: ImageBackend) {
    this.current = initial;
  }

  replace(next: ImageBackend): void {
    this.current = next;
  }

  probe(signal?: AbortSignal): Promise<BackendCapabilities> {
    return this.current.probe(signal);
  }

  listCandidates(kind: CandidateKind, signal?: AbortSignal): Promise<Candidate[]> {
    return this.current.listCandidates(kind, signal);
  }

  // 呼んだ時点のバックエンドを握ったまま待つ: 走っている生成を途中で別のバックエンドへ移すことはできず、結果も古い側から返るため
  generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
    return this.current.generate(req, signal);
  }

  // 古い側ではなく、いまの側へ送る: 差し替えた直後の「止める」は、繋ぎ直した先の Forge を止める操作として押されるため。古い側で走り続けている生成は止まらない（signal の abort で待ちは切れる）
  interrupt(): Promise<void> {
    return this.current.interrupt();
  }
}
