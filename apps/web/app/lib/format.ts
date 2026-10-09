/** 見る役の score。小数2桁で出す: 浮動小数の誤差（0.44999999999999996 など）を画面に持ち込まないため */
export function formatScore(score: number): string {
  return score.toFixed(2);
}

const MS_PER_SECOND = 1000;

/** 所要時間。1秒未満は ms の整数、1秒以上は秒の小数1桁で出す */
export function formatDuration(ms: number): string {
  return ms < MS_PER_SECOND ? `${Math.round(ms)} ms` : `${(ms / MS_PER_SECOND).toFixed(1)} 秒`;
}
