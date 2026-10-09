import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { CandidateNotes } from '@drawroid/core';
import { z } from 'zod';

import { writeJsonAtomic } from './atomic.js';

/** 候補の説明を、「候補の名前 → 説明」の JSON として丸ごと書く。検証は呼び手（API）が行う */
export async function writeCandidateNotes(
  path: string,
  notes: Readonly<Record<string, string>>,
): Promise<void> {
  await writeJsonAtomic(path, notes);
}

// 候補の名前 → 説明（architecture の配置の candidate-notes.json）
const candidateNotesSchema = z.record(z.string().min(1), z.string().trim().min(1));

/**
 * 人間が候補に付けた短い説明を読む。読めなければ、理由を添えて説明なしを返す（ループは止めない）。
 */
// キャッシュを持たない: 人間がファイルを直接直したら、次のジョブからそのまま反映されるようにするため
export async function readCandidateNotes(path: string): Promise<CandidateNotes> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { notes: new Map() };
    return { notes: new Map(), problem: `${basename(path)} を読めない: ${String(error)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      notes: new Map(),
      problem: `${basename(path)} が JSON として読めない: ${(error as Error).message}`,
    };
  }
  const parsed = candidateNotesSchema.safeParse(json);
  if (!parsed.success) {
    return {
      notes: new Map(),
      problem: `${basename(path)} が「候補の名前 → 説明」の形ではない: ${parsed.error.issues[0]?.message ?? ''}`,
    };
  }
  return { notes: new Map(Object.entries(parsed.data)) };
}
