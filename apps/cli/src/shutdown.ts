import type { ReplaceableBackend } from './replaceable-backend.js';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

const EXIT_CODES: Record<ShutdownSignal, number> = { SIGINT: 130, SIGTERM: 143 };

export interface ShutdownOptions {
  backend: Pick<ReplaceableBackend, 'generating' | 'interrupt'>;
  exit: (code: number) => void;
  log: (line: string) => void;
  /** バックエンドが中断に答えないときに、待つのをやめるまで */
  timeoutMs?: number;
}

/**
 * 止める合図（SIGINT・SIGTERM）を受けたときにすること。drawroid の生成が走っていれば、バックエンドに止めさせてから終わる。
 * 止めないと、プロセスが消えても GPU は前の生成を回し続け、起動し直したあとの生成がその後ろで待たされるため。
 */
// ジョブの状態は書き換えない: 「止まった」にすると、起動し直したときに続きから再開しなくなるため（段単位の再開）
export function shutdownHandler({
  backend,
  exit,
  log,
  timeoutMs = 3_000,
}: ShutdownOptions): (signal: ShutdownSignal) => Promise<void> {
  let shuttingDown = false;
  return async (signal) => {
    // 2度目の合図ではすぐ終わる: 中断に答えないバックエンドを待っている間も、人が終わらせられるように
    if (shuttingDown) {
      exit(EXIT_CODES[signal]);
      return;
    }
    shuttingDown = true;
    if (backend.generating) {
      log('drawroid: 走っている生成をバックエンドに止めさせてから終わる');
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          backend.interrupt(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } catch (error) {
        log(
          `drawroid: バックエンドに生成を止めさせられなかった: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    exit(EXIT_CODES[signal]);
  };
}
