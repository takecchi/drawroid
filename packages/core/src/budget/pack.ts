export type PackLimits = {
  /** 入れてよい件数 */
  maxCount?: number;
  /** 入れてよい大きさの合計（単位は size が返すもの: 文字数・トークンの見積もりなど） */
  maxSize?: number;
};

export type PackOptions<T> = {
  /** 1件の大きさ */
  size: (item: T) => number;
  /** 優先順位。負なら a を先に入れる。同順位は元の並びを保つ */
  compare?: (a: T, b: T) => number;
  limits: PackLimits;
};

export type DroppedReason = 'count' | 'size';

export type PackResult<T> = {
  /** 入れたもの（優先順位の順） */
  included: T[];
  /** 落としたもの（優先順位の順）と、どの上限で落ちたか */
  dropped: { item: T; reason: DroppedReason }[];
  usedSize: number;
};

/**
 * 優先順位の順に、上限の内に入るものだけを詰める。
 * 入りきらない1件は落として、その後ろの小さいものは引き続き詰める。
 */
// 落としたものを捨てずに返す: 予算で何を落としたかを隠さず記録に残すため（PRD「好みの記憶」）
export function packWithinBudget<T>(items: readonly T[], options: PackOptions<T>): PackResult<T> {
  const { size, compare, limits } = options;
  const ordered =
    compare === undefined
      ? [...items]
      : items
          .map((item, index) => ({ item, index }))
          .sort((a, b) => compare(a.item, b.item) || a.index - b.index)
          .map(({ item }) => item);

  const included: T[] = [];
  const dropped: PackResult<T>['dropped'] = [];
  let usedSize = 0;
  for (const item of ordered) {
    if (limits.maxCount !== undefined && included.length >= limits.maxCount) {
      dropped.push({ item, reason: 'count' });
      continue;
    }
    const itemSize = size(item);
    if (limits.maxSize !== undefined && usedSize + itemSize > limits.maxSize) {
      dropped.push({ item, reason: 'size' });
      continue;
    }
    included.push(item);
    usedSize += itemSize;
  }
  return { included, dropped, usedSize };
}
