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

// 起動したままバックエンドの URL を変えられるようにする入れ物。ManualGenerationRunner などが握るのはこの入れ物で、中身だけが替わる。
// 生成を1本ずつ通す役も持つ: 手動の生成と自動のジョブの生成はどちらもここを通り、GPU は1枚と仮定するので重ねて投げないため
export class ReplaceableBackend implements ImageBackend {
  private current: ImageBackend;
  private running = 0;
  /** いちばん後ろに並んだ生成が終わったら解ける。次の生成はこれを待ってから中身へ渡す */
  private tail: Promise<void> = Promise.resolve();
  /** 中身へ渡した（走っている）生成の signal */
  private handed: AbortSignal | undefined;
  /** 順番待ちの生成が、いま止められたところか。同じ流れの中で来た interrupt() を、走っている別の生成へ渡さないために持つ */
  private waitingStopped = false;

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

  /**
   * 来た順に1本ずつ中身へ渡す。待っている間に signal が止められたら、中身へ渡さずに AbortError で抜ける。
   */
  // 待たせるのは生成だけ: 進み具合・中断・候補の取得まで待たせると、走っている生成を見ることも止めることもできなくなるため。
  // 1回の生成の間だけ持つ: ジョブ1つの間持つと、手動の生成が自動のジョブが止まるまで始まらなくなるため
  async generate(
    req: GenerationRequest,
    signal: AbortSignal,
    images?: GenerationImages,
  ): Promise<GenerationResult> {
    this.running += 1;
    const before = this.tail;
    let done!: () => void;
    this.tail = new Promise((resolve) => (done = resolve));
    try {
      await waitUnlessAborted(before, signal, () => this.markWaitingStopped());
      this.handed = signal;
      return await this.current.generate(req, signal, images);
    } finally {
      if (this.handed === signal) this.handed = undefined;
      // 順番待ちのまま抜けたときも、前の生成が終わってから後ろへ譲る: 先に譲ると、後ろが前の生成と重なるため
      void before.then(done);
      this.running -= 1;
    }
  }

  // 止める口（JobRunner.stop・ManualGenerationRunner.stop）は、signal を止めたその流れの中で interrupt() を呼ぶ。
  // 印はその流れの間だけ持つ: 残すと、あとで来る interrupt()（終わるときの合図の処理など）まで握りつぶすため
  private markWaitingStopped(): void {
    this.waitingStopped = true;
    queueMicrotask(() => (this.waitingStopped = false));
  }

  /** drawroid の生成が走っているか（この入れ物を通した generate が返っていないか） */
  get generating(): boolean {
    return this.running > 0;
  }

  /**
   * 走っている生成を止めさせる。ただし、順番待ちの生成を止めた流れで来たものは、走っている別の生成へは渡さない
   */
  // interrupt() はバックエンドの今の生成を止めるので、順番待ちの生成を止めるために呼ばれたものを渡すと、
  // 走っている別のジョブの生成まで止まるため。走っている生成そのものが止められたときは渡す
  interrupt(): Promise<void> {
    if (this.waitingStopped && this.handed?.aborted !== true) return Promise.resolve();
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

/** turn が解けるまで待つ。先に signal が止められたら onAborted を呼び、AbortError で抜ける */
function waitUnlessAborted(
  turn: Promise<void>,
  signal: AbortSignal,
  onAborted: () => void,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      onAborted();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void turn.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function abortError(): Error {
  return Object.assign(new Error('生成の順番を待っている間に止められた'), { name: 'AbortError' });
}
