// 1 分に満たない長さは秒で書く: 分に丸めると「0 分」になり、人にも話す役にも意味が通らないため。
// 1 秒に満たない長さはミリ秒で書く: 秒に丸めると同じく「0 秒」になるため。秒に丸めて 60 になるなら分で書く（「60 秒」にしない）
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ミリ秒`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.round(ms / 60_000)} 分`;
}
