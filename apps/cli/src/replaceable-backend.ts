import { BackendBusyError } from '@drawroid/api';
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

// 起動したままバックエンドの URL を変えられるようにする入れ物。ManualGenerationRunner などが握るのはこの入れ物で、中身だけが替わる
export class ReplaceableBackend implements ImageBackend {
  private current: ImageBackend;
  private running = 0;

  constructor(initial: ImageBackend) {
    this.current = initial;
  }

  /**
   * 中身を差し替え、前の中身を返す。生成が走っているあいだは BackendBusyError を投げて差し替えない。
   */
  // 走っているあいだは断る: 差し替えると「止める」が新しい側へ行き、古い Forge の生成を止める手段が無くなるため
  replace(next: ImageBackend): ImageBackend {
    if (this.running > 0) {
      throw new BackendBusyError(
        '生成が走っているあいだは繋ぎ直せない。生成が終わるか、止めてからやり直す',
      );
    }
    const previous = this.current;
    this.current = next;
    return previous;
  }

  probe(signal?: AbortSignal): Promise<BackendCapabilities> {
    return this.current.probe(signal);
  }

  listCandidates(kind: CandidateKind, signal?: AbortSignal): Promise<Candidate[]> {
    return this.current.listCandidates(kind, signal);
  }

  async generate(
    req: GenerationRequest,
    signal: AbortSignal,
    images?: GenerationImages,
  ): Promise<GenerationResult> {
    this.running += 1;
    try {
      return await this.current.generate(req, signal, images);
    } finally {
      this.running -= 1;
    }
  }

  /** drawroid の生成が走っているか（この入れ物を通した generate が返っていないか） */
  get generating(): boolean {
    return this.running > 0;
  }

  interrupt(): Promise<void> {
    return this.current.interrupt();
  }

  // 中身が持たなければ undefined: 持たないアダプタは「何も走っていない」と同じに見えてよい（画面は「生成中」とだけ出す）
  async progress(
    signal: AbortSignal,
    options?: { includePreview?: boolean },
  ): Promise<GenerationProgress | undefined> {
    return this.current.progress?.(signal, options);
  }
}
