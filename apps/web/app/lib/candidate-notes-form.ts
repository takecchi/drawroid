import type { FormResult } from './stop-conditions-form';

// api の candidate-notes.ts と同じ値。api を runtime で import しない: サーバ側の依存をブラウザの成果物へ引き込まないため
export const MAX_CANDIDATE_NOTE_CHARS = 200;

/** 画面の欄から、保存する説明の全部を組む。空にした説明は外す（消すのは、外して全部を送り直すこと） */
export function buildNotes(edits: Record<string, string>): FormResult<Record<string, string>> {
  const notes: Record<string, string> = {};
  for (const [name, text] of Object.entries(edits)) {
    const trimmed = text.trim();
    if (trimmed === '') continue;
    if (trimmed.length > MAX_CANDIDATE_NOTE_CHARS) {
      return {
        ok: false,
        reason: `${name}: 説明は ${MAX_CANDIDATE_NOTE_CHARS} 文字まで（いまは ${trimmed.length} 文字）`,
      };
    }
    notes[name] = trimmed;
  }
  return { ok: true, value: notes };
}

/** 説明はあるが、今のどの候補にも無い名前（バックエンドから消えた候補など） */
export function orphanNames(notes: Record<string, string>, listed: readonly string[]): string[] {
  const known = new Set(listed);
  return Object.keys(notes)
    .filter((name) => !known.has(name))
    .sort();
}

/** 名前の一部で候補を絞る。大文字と小文字は区別しない */
export function matchesFilter(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.trim().toLowerCase());
}
