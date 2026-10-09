import { Hono } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { jsonBody } from '../validate.js';

/** 説明1件の長さ。考える役に載る量は、別に候補の予算（selectCandidates）が締める。クローンが決めた値 */
export const MAX_CANDIDATE_NOTE_CHARS = 200;
/** 説明を付けられる候補の数。LoRA が数百個ある環境を想定する。クローンが決めた値 */
export const MAX_CANDIDATE_NOTES = 5000;

// 名前 → 説明を丸ごと受ける: 部分の更新にすると、消したい説明を消す口が別に要るため
const notesSchema = z
  .record(z.string().min(1).max(500), z.string().trim().min(1).max(MAX_CANDIDATE_NOTE_CHARS))
  .refine((notes) => Object.keys(notes).length <= MAX_CANDIDATE_NOTES, {
    message: `説明は ${MAX_CANDIDATE_NOTES} 件まで`,
  });

/**
 * 候補への人間の短い説明（candidate-notes.json）。書いた説明は、次のジョブから考える役に渡る。
 */
export function candidateNotesRoutes({ candidateNotes }: ApiDeps) {
  return new Hono()
    .get('/candidate-notes', async (c) => {
      const { notes, problem } = await candidateNotes.read();
      // 読めないファイルは、説明なしと理由を返す: ループも同じく説明なしで進むので、画面にも同じ状態を見せる
      return c.json(
        { notes: Object.fromEntries(notes), ...(problem === undefined ? {} : { problem }) },
        200,
      );
    })
    .put('/candidate-notes', jsonBody(notesSchema), async (c) => {
      const notes = c.req.valid('json');
      await candidateNotes.write(notes);
      return c.json({ notes }, 200);
    });
}
