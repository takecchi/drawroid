import type { GenerationRequest, GenerationResult } from '@drawroid/core';
import { StubBackend, type Script } from '@drawroid/core/testing';

/**
 * blockOn が true を返す n 回目の呼び出しを、answer(n) まで返さない。呼び出しの signal を残す。
 * reached(count) は、count 回呼ばれたら解ける
 */
// 呼ばれた数を時間で見回らずに待てるようにする: ジョブがそこまで進む時間は、CI が混むと vi.waitFor の既定（1 秒）を超えるため
export function blocking(inner: Script, blockOn: (n: number) => boolean) {
  const signals: AbortSignal[] = [];
  const answers = new Map<number, () => void>();
  const waiting: { count: number; resolve: () => void }[] = [];
  const script: Script = (call, n) => {
    signals.push(call.signal);
    for (const wait of waiting.filter(({ count }) => signals.length >= count)) {
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve();
    }
    if (!blockOn(n)) return inner(call, n);
    return new Promise((resolve) => answers.set(n, () => resolve(inner(call, n))));
  };
  const reached = (count: number) =>
    signals.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiting.push({ count, resolve }));
  return { script, signals, answer: (n: number) => answers.get(n)?.(), reached };
}

/**
 * openGenerate() まで generate を返さないバックエンド。generate に渡った signal を残す。
 * generated(count) は、generate が count 回呼ばれたら解ける
 */
// 呼ばれた数を時間で見回らずに待てるようにする: 描く段に着くまでの時間は、CI が混むと vi.waitFor の既定（1 秒）を超えるため
export class GatedBackend extends StubBackend {
  readonly generateSignals: AbortSignal[] = [];
  private open: () => void = () => undefined;
  private readonly opened = new Promise<void>((resolve) => (this.open = resolve));
  private readonly waiting: { count: number; resolve: () => void }[] = [];
  constructor(private readonly gated: boolean) {
    super();
  }
  openGenerate(): void {
    this.open();
  }
  generated(count: number): Promise<void> {
    if (this.generateSignals.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push({ count, resolve }));
  }
  override async generate(
    req: GenerationRequest,
    signal: AbortSignal,
    inputs?: Parameters<StubBackend['generate']>[2],
  ): Promise<GenerationResult> {
    this.generateSignals.push(signal);
    for (const wait of this.waiting.filter(({ count }) => this.generateSignals.length >= count)) {
      this.waiting.splice(this.waiting.indexOf(wait), 1);
      wait.resolve();
    }
    if (this.gated) {
      // 止められたら、本物の HTTP の待ちのように、待ちを切って投げる
      await new Promise<void>((resolve, reject) => {
        const onAbort = () =>
          reject(Object.assign(new Error('呼び手が止めた'), { name: 'AbortError' }));
        if (signal.aborted) onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        void this.opened.then(resolve);
      });
    }
    return super.generate(req, signal, inputs);
  }
}
