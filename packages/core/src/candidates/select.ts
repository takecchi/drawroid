import { type CharBudget, type PackByBudget, packGreedily } from '../budget/pack.js';
import type { Candidate } from '../backend.js';

export interface ShownCandidate {
  name: string;
  note?: string;
}

export interface CandidateSelection {
  shown: ShownCandidate[];
  droppedByBudget: string[];
  notesDroppedByBudget: string[];
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
  budget: CharBudget,
  pack: PackByBudget = packGreedily,
): CandidateSelection {
  const gist = normalize(requestGist);
  const allowed =
    choices === undefined ? candidates : candidates.filter((c) => choices.includes(c.name));
  const rank = (c: Candidate) => (notes.has(c.name) ? 0 : appearsInGist(c, gist) ? 1 : 2);
  const ordered = [...allowed].sort(
    (a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  // 名前を先に詰め、説明は残りの文字数に入るぶんだけ付ける: 予算が足りないときは候補より先に説明を削るため（architecture の削る順）
  const names = pack(ordered, (c) => c.name.length, budget);
  const usedByNames = names.kept.reduce((sum, c) => sum + c.name.length, 0);
  const noted = names.kept.filter((c) => notes.has(c.name));
  const notesKept = pack(noted, (c) => notes.get(c.name)?.length ?? 0, {
    maxItems: noted.length,
    maxChars: budget.maxChars - usedByNames,
  });
  const keptNoteNames = new Set(notesKept.kept.map((c) => c.name));

  return {
    shown: names.kept.map((c): ShownCandidate => {
      const note = notes.get(c.name);
      return note !== undefined && keptNoteNames.has(c.name)
        ? { name: c.name, note }
        : { name: c.name };
    }),
    droppedByBudget: names.dropped.map((c) => c.name),
    notesDroppedByBudget: notesKept.dropped.map((c) => c.name),
  };
}
