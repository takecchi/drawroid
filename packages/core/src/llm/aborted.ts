import {
  LlmCallAborted,
  type LlmAttempt,
  type LlmCall,
  type LlmCallOutcome,
  type LlmPort,
} from './port.js';

/** 呼び手の中断で打ち切った呼び出しの、記録に残す理由。時間切れ・スキーマ違い・ネットワークの失敗とは別の言い方にする */
export const LLM_CALL_ABORTED_REASON =
  '呼び手が打ち切った（人の停止・会話の割り込み・段のやり直し）。出力は打ち切るまでの分だけ';

/**
 * 構造化出力を求め、呼び手の中断で打ち切られたら、途中までの試行つきの失敗として onAborted へ渡してから、中断をそのまま投げる。
 */
// 記録の失敗は握って log に流す: 記録を書けなかったことで、打ち切り（ジョブが human で止まる・ターンが interrupted で閉じる）を妨げないため
export async function generateRecordingAbort<T>(
  llm: Pick<LlmPort, 'generateStructured'>,
  call: LlmCall<T>,
  onAborted: (outcome: LlmCallOutcome<never>) => Promise<void>,
  log?: (message: string) => void,
): Promise<LlmCallOutcome<T>> {
  try {
    return await llm.generateStructured(call);
  } catch (error) {
    if (call.signal.aborted) {
      const attempts: LlmAttempt[] = error instanceof LlmCallAborted ? error.attempts : [];
      try {
        await onAborted({ ok: false, reason: LLM_CALL_ABORTED_REASON, attempts });
      } catch (recordError) {
        log?.(
          `drawroid: 打ち切った LLM 呼び出しの記録を書けなかった: ${recordError instanceof Error ? recordError.message : String(recordError)}`,
        );
      }
    }
    throw error;
  }
}
