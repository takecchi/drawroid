/**
 * 走っているジョブの LLM の段を待たせる門。待たせる口は数えて重ねられ、全部解けたときだけ開く。
 * 生成（GPU）はここを通らない。通るのは、LLM を呼ぶ段（考える・見る・参照画像の要点）だけ。
 */
export class LlmGate {
  private holds = 0;
  private closed = false;
  private waiters: (() => void)[] = [];
  private stage: AbortController | undefined;

  constructor(private readonly onHeld: (held: boolean) => void) {}

  /** 待たせる。戻り値で解く（2回呼んでも1回分）。いま走っている LLM の呼び出しは、その呼び出しだけ abort する */
  hold(): () => void {
    if (this.closed) return () => undefined;
    this.holds++;
    if (this.holds === 1) this.onHeld(true);
    this.stage?.abort();
    let released = false;
    return () => {
      if (released || this.closed) return;
      released = true;
      this.holds--;
      if (this.holds > 0) return;
      this.onHeld(false);
      for (const wake of this.waiters.splice(0)) wake();
    };
  }

  /** ジョブが終わった。待たせたままでも、抜けたことを知らせて以後の口を何もしないものにする */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.holds > 0) this.onHeld(false);
    this.holds = 0;
    for (const wake of this.waiters.splice(0)) wake();
  }

  /**
   * 段を、待たせていない間にだけ始める。段の最中に待たせたら、その段の LLM 呼び出しを abort し、解けてから段ごとやり直す。
   * ジョブ全体の signal（人間の停止）は、待っている間も効く。
   */
  // 段ごとやり直す: 待っている間に届いた指示や選択を、やり直す段の入力・判断に反映するため
  async runStage<T>(jobSignal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (;;) {
      await this.untilFree(jobSignal);
      const own = new AbortController();
      this.stage = own;
      try {
        return await run(AbortSignal.any([jobSignal, own.signal]));
      } catch (error) {
        if (jobSignal.aborted || !own.signal.aborted) throw error;
      } finally {
        this.stage = undefined;
      }
    }
  }

  // 起こされてから動き出すまでの間に新しく待たせることがあるので、開いているのを見直す
  private async untilFree(jobSignal: AbortSignal): Promise<void> {
    jobSignal.throwIfAborted();
    while (this.holds > 0) await this.wait(jobSignal);
  }

  private wait(jobSignal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        jobSignal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        reject(jobSignal.reason);
      };
      this.waiters.push(wake);
      jobSignal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
