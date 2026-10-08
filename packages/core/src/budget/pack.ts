export interface CharBudget {
  maxItems: number;
  maxChars: number;
}

export interface Packed<T> {
  kept: T[];
  dropped: T[];
}

// M2 の共通の詰め方に寄せるときは、この型を満たす関数を渡し替えるだけで済むようにしておく
export type PackByBudget = <T>(
  items: readonly T[],
  measure: (item: T) => number,
  budget: CharBudget,
) => Packed<T>;

// 入りきらない項目で打ち切らず、後ろの短い項目は入れる: 長い1項目のせいで後ろが全部落ちるのを避けるため
export const packGreedily: PackByBudget = (items, measure, budget) => {
  const kept: (typeof items)[number][] = [];
  const dropped: (typeof items)[number][] = [];
  let usedChars = 0;
  for (const item of items) {
    const size = measure(item);
    if (kept.length < budget.maxItems && usedChars + size <= budget.maxChars) {
      kept.push(item);
      usedChars += size;
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped };
};
