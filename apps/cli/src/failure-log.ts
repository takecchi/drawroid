import type { JobState, JobStore } from '@drawroid/core';

/**
 * ジョブの置き場所を包み、ジョブが失敗で止まったら、端末に1行出す。画面を見ていなくても、失敗に気づけるようにするため。
 * 言葉は画面にそろえる（止まりのカードの「描くのを止めた」と、ジョブの詳細に出す止まった理由の文）
 */
// 失敗（error）だけを出す: AI の判断・上限・人の止め・人が選んだ止まりは、失敗ではないため。
// 書けたあとに出す: ジョブのファイルが正なので、書けなかった止まりを出さないため
export function logFailedJobs(inner: JobStore, log: (line: string) => void): JobStore {
  const writeState = async (jobId: string, state: JobState) => {
    await inner.writeState(jobId, state);
    if (state.status === 'stopped' && state.reason.kind === 'error') {
      log(`drawroid: 描くのを止めた（ジョブ ${jobId}）: ${state.reason.detail}`);
    }
  };
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'writeState') return writeState;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
