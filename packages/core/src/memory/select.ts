import { type CharBudget, type PackByBudget, packGreedily } from '../budget/pack.js';
import type { MemoryItem } from './item.js';

export interface MemorySelection {
  selected: MemoryItem[];
  droppedByBudget: MemoryItem[];
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

// 関係する項目を選ぶのに LLM を使わない: 選ぶためにトークンを使えば、記憶が増えるほど入力が膨らむため
export function selectMemory(
  items: readonly MemoryItem[],
  requestGist: string,
  budget: CharBudget,
  pack: PackByBudget = packGreedily,
): MemorySelection {
  const gist = normalize(requestGist);
  const relevant = items
    .map((item) => ({ item, matchedTags: countMatchedTags(item, gist) }))
    .filter((ranked) => ranked.item.scope === 'always' || ranked.matchedTags > 0)
    .sort(compareRanked)
    .map((ranked) => ranked.item);
  const { kept, dropped } = pack(relevant, (item) => item.body.length, budget);
  return { selected: kept, droppedByBudget: dropped };
}
