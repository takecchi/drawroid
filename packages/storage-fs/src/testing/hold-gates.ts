import type { GenerationRequest, GenerationResult } from '@drawroid/core';
import { StubBackend, type Script } from '@drawroid/core/testing';

/** blockOn が true を返す n 回目の呼び出しを、answer(n) まで返さない。呼び出しの signal を残す */
export function blocking(inner: Script, blockOn: (n: number) => boolean) {
  const signals: AbortSignal[] = [];
  const answers = new Map<number, () => void>();
  const script: Script = (call, n) => {
    signals.push(call.signal);
    if (!blockOn(n)) return inner(call, n);
    return new Promise((resolve) => answers.set(n, () => resolve(inner(call, n))));
  };
  return { script, signals, answer: (n: number) => answers.get(n)?.() };
}

/** openGenerate() まで generate を返さないバックエンド。generate に渡った signal を残す */
export class GatedBackend extends StubBackend {
  readonly generateSignals: AbortSignal[] = [];
  private open: () => void = () => undefined;
  private readonly opened = new Promise<void>((resolve) => (this.open = resolve));
  constructor(private readonly gated: boolean) {
    super();
  }
  openGenerate(): void {
    this.open();
  }
  override async generate(
    req: GenerationRequest,
    signal: AbortSignal,
    inputs?: Parameters<StubBackend['generate']>[2],
  ): Promise<GenerationResult> {
    this.generateSignals.push(signal);
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
