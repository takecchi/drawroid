import type { Candidate } from '../backend.js';
import { type PackLimits, type PackResult, packWithinBudget } from '../budget/pack.js';

export interface ShownCandidate {
  name: string;
  note?: string;
}

export interface CandidateSelection {
  shown: ShownCandidate[];
  droppedByBudget: PackResult<string>['dropped'];
  notesDroppedByBudget: PackResult<string>['dropped'];
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

function appearsInGist(candidate: Candidate, gist: string): boolean {
  return [candidate.name, candidate.label ?? ''].some((word) => {
    const needle = normalize(word).trim();
    return needle !== '' && gist.includes(needle);
  });
}

// 候補の一覧を全件流さない: LoRA が数百個ある環境では、それだけで小さなコンテキストが溢れるため
export function selectCandidates(
  candidates: readonly Candidate[],
  choices: readonly string[] | undefined,
  notes: ReadonlyMap<string, string>,
  requestGist: string,
  limits: PackLimits,
): CandidateSelection {
  const gist = normalize(requestGist);
  const allowed =
    choices === undefined ? candidates : candidates.filter((c) => choices.includes(c.name));
  const rank = (c: Candidate) => (notes.has(c.name) ? 0 : appearsInGist(c, gist) ? 1 : 2);

  // 名前を先に詰め、説明は残りの大きさに入るぶんだけ付ける: 予算が足りないときは候補より先に説明を削るため（architecture の削る順）
  const names = packWithinBudget(
    allowed.map((c) => ({ name: c.name, rank: rank(c) })),
    {
      size: (c) => c.name.length,
      compare: (a, b) => a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      limits,
    },
  );
  const notesKept = packWithinBudget(
    names.included.map((c) => c.name).filter((name) => notes.has(name)),
    {
      size: (name) => notes.get(name)?.length ?? 0,
      limits: limits.maxSize === undefined ? {} : { maxSize: limits.maxSize - names.usedSize },
    },
  );
  const keptNotes = new Set(notesKept.included);

  return {
    shown: names.included.map(({ name }): ShownCandidate => {
      const note = notes.get(name);
      return note !== undefined && keptNotes.has(name) ? { name, note } : { name };
    }),
    droppedByBudget: names.dropped.map(({ item, reason }) => ({ item: item.name, reason })),
    notesDroppedByBudget: notesKept.dropped,
  };
}
