import type { DetectedContext, LlmConfig } from '@drawroid/llm';

/**
 * 窓を読み直す間隔の下限（前の読みが終わってから）。
 */
// 使うたびには読まない: 応答しない LLM では、読みが /v1/models の時間切れ（5 秒）まで待ち、ジョブも会話のターンも毎回その分遅れるため。
// 短すぎれば、読み込み中の LLM を何度も叩く。長すぎれば（数分）、LLM が上がったあとも、最初の1件が既定の窓で走る。
// モデルの読み込みは数十秒かかるので、その長さに合わせる。応答しない LLM でも 30 秒に 1 回の 5 秒で済む
export const WINDOW_REREAD_INTERVAL_MS = 30_000;

type Detection = { config: LlmConfig; detected: DetectedContext[] };

/**
 * 起動や保存のときに窓を読めなかった役の窓を、次に LLM を使うときに読み直す。
 * いま効いている設定（読めた窓を埋めたもの）を読み直すので、全部の役の窓が分かったあとは /v1/models を叩かない。
 * 同時に呼ばれても読みは1本で、間隔の下限より前には読まない
 */
export function createWindowReread(deps: {
  /** いま効いている設定（読めた窓を埋めたもの） */
  current: () => LlmConfig | undefined;
  detect: (llm: LlmConfig) => Promise<Detection>;
  /** 読めた窓を効かせる。読み直しの途中で設定が差し替わっていたら呼ばない */
  apply: (detection: Detection) => void;
  now: () => number;
}) {
  let lastReadAt = deps.now();
  let reading: Promise<void> | undefined;
  return {
    /** 設定を効かせるとき、そこで読んだ（読もうとした）ことを覚える */
    markRead(): void {
      lastReadAt = deps.now();
    },
    reread(): Promise<void> {
      if (reading !== undefined) return reading;
      const base = deps.current();
      if (base === undefined) return Promise.resolve();
      if (deps.now() - lastReadAt < WINDOW_REREAD_INTERVAL_MS) return Promise.resolve();
      reading = (async () => {
        try {
          const detection = await deps.detect(base);
          lastReadAt = deps.now();
          if (deps.current() === base && detection.detected.length > 0) deps.apply(detection);
        } finally {
          reading = undefined;
        }
      })();
      return reading;
    },
  };
}
