import { useEffect, useRef, useState } from 'react';

/** 流れている返答を描き直す間隔の下限 */
export const STREAMING_REDRAW_MS = 50;

/**
 * 流れている間（`active`）は、文字の変化を最大で `intervalMs` に1回だけ返す。最後に来た文字は、間隔が来たら必ず返す。
 * 流れていなければ、渡された文字をそのまま返す（確定した返答は、遅れずに一度に描いたものと同じになる）。
 *
 * 間隔の頭ではなく、間隔の中で最後に来た文字を返す: 頭の文字だけを描くと、増分が止まった時点の末尾が描かれずに残るため。
 */
export function useThrottledText(
  text: string,
  active: boolean,
  intervalMs = STREAMING_REDRAW_MS,
): string {
  const [shown, setShown] = useState(text);
  const lastDrawnAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (!active) return;
    const wait = lastDrawnAt.current + intervalMs - Date.now();
    const draw = () => {
      lastDrawnAt.current = Date.now();
      setShown(text);
    };
    if (wait <= 0) {
      draw();
      return;
    }
    // 間隔の中で次の文字が来たら、前の予約を外して最後の文字で予約し直す（描く時刻は変えない）
    const timer = setTimeout(draw, wait);
    return () => clearTimeout(timer);
  }, [text, active, intervalMs]);
  return active ? shown : text;
}
