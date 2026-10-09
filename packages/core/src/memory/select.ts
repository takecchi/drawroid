import { type PackLimits, type PackResult, packWithinBudget } from '../budget/pack.js';
import type { MemoryItem } from './item.js';

/**
 * 1つの役に載せる記憶の予算。always があれば、scope: always の項目はその枠で、残りは外側の枠で詰める。
 * always が無ければ、両方が同じ枠を分け合う。
 */
// always を同じ枠で詰めない: always は常に先頭に並ぶので、増えるほど依頼に当たった tagged を押し出すため。
// 別枠にしておけば、always が溢れても tagged の枠は減らず、溢れた always は落とした項目として記録に残る（Issue #5 の C、M5:145）
export type MemoryRoleLimits = PackLimits & { always?: PackLimits };

export interface MemorySelection {
  selected: MemoryItem[];
  droppedByBudget: PackResult<MemoryItem>['dropped'];
}

/** 予算で落とした項目の、記録に残す理由。always 枠で落ちたものは見分けられるようにする */
export function describeMemoryDrop(
  dropped: MemorySelection['droppedByBudget'][number],
  limits: MemoryRoleLimits,
): string {
  const frame =
    limits.always !== undefined && dropped.item.scope === 'always' ? ' always 枠の' : '';
  const measure = dropped.reason === 'count' ? '件数' : '文字数';
  return `記憶の${frame}${measure}の予算に入らない`;
}

interface Ranked {
  item: MemoryItem;
  matchedTags: number;
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

function countMatchedTags(item: MemoryItem, gist: string): number {
  return item.tags.filter((tag) => {
    const needle = normalize(tag).trim();
    return needle !== '' && gist.includes(needle);
  }).length;
}

function compareRanked(a: Ranked, b: Ranked): number {
  const scopeOrder = Number(b.item.scope === 'always') - Number(a.item.scope === 'always');
  if (scopeOrder !== 0) return scopeOrder;
  if (a.matchedTags !== b.matchedTags) return b.matchedTags - a.matchedTags;
  const updatedOrder = Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt);
  if (updatedOrder !== 0) return updatedOrder;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

function pack(ranked: Ranked[], limits: PackLimits): MemorySelection {
  const { included, dropped } = packWithinBudget(ranked, {
    size: (r) => r.item.body.length,
    compare: compareRanked,
    limits,
  });
  return {
    selected: included.map((r) => r.item),
    droppedByBudget: dropped.map(({ item, reason }) => ({ item: item.item, reason })),
  };
}

// 関係する項目を選ぶのに LLM を使わない: 選ぶためにトークンを使えば、記憶が増えるほど入力が膨らむため
export function selectMemory(
  items: readonly MemoryItem[],
  requestGist: string,
  limits: MemoryRoleLimits,
): MemorySelection {
  const gist = normalize(requestGist);
  const relevant = items
    .map((item) => ({ item, matchedTags: countMatchedTags(item, gist) }))
    .filter((ranked) => ranked.item.scope === 'always' || ranked.matchedTags > 0);
  const { always: alwaysLimits, ...sharedLimits } = limits;
  if (alwaysLimits === undefined) return pack(relevant, sharedLimits);

  const always = pack(
    relevant.filter((r) => r.item.scope === 'always'),
    alwaysLimits,
  );
  const tagged = pack(
    relevant.filter((r) => r.item.scope !== 'always'),
    sharedLimits,
  );
  return {
    selected: [...always.selected, ...tagged.selected],
    droppedByBudget: [...always.droppedByBudget, ...tagged.droppedByBudget],
  };
}
