import { describeStorageFailure } from '@drawroid/api';

/** 起動で止まった理由を、何が起きたかと次に何をするかの1行にする（積み上げは出さない） */
export function describeStartupFailure(error: unknown): string {
  const failure = error as NodeJS.ErrnoException | null;
  if (failure?.code === 'EADDRINUSE') {
    return 'drawroid: ポートが既に使われている。--port で別のポートを指定する';
  }
  // 何が起きたかは画面と同じ言葉にし、端末では置き場所と、起動し直すための手を言う
  const storage = describeStorageFailure(error);
  if (storage !== undefined) {
    const at = failure?.path === undefined ? '' : `: ${failure.path}`;
    const next =
      failure?.code === 'ENOSPC'
        ? '空きを作ってから起動し直す'
        : 'drawroid を動かしているユーザーが書ける場所かを確かめるか、--data-dir で書ける場所を指して起動し直す';
    return `drawroid: ${storage.said}${at}。${next}`;
  }
  return `drawroid: ${error instanceof Error ? error.message : String(error)}`;
}
