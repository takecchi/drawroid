import { z } from 'zod';

import { clipText } from '../budget/estimate.js';
import type { ReferenceRecord } from '../job/types.js';
import type { CarriedReference } from '../loop/carry.js';

/** 持ち回す参照画像の要点の件数と、要点・用途の言葉の文字数 */
export type ReferenceLimits = {
  maxCount: number;
  gistChars: number;
  noteChars: number;
};

// 値は仮置き。設定（config.json の budgets）の既定値として、実測で見直す。
// 件数は、1回の要求で添えてよい枚数（MAX_REFERENCES_PER_REQUEST）と同じにする: 少ないと、添えてよいと言った画像のうち
// 最初のものが、考える役に一度も見えないため。定数を import しない: job/types が予算の設定を通してこのファイルを読み、循環するため
export const DEFAULT_REFERENCE_LIMITS: ReferenceLimits = {
  maxCount: 4,
  gistChars: 200,
  noteChars: 100,
};

/** ref-gist の出力スキーマ。要点だけを短く書かせる */
export function buildRefGistOutputSchema() {
  // 文字数の上限を出力に付けない: 持ち回すときに gistChars で切るため
  return z.object({ gist: z.string().min(1) });
}
export type RefGistOutput = z.infer<ReturnType<typeof buildRefGistOutputSchema>>;

/** 要点がまだ無い参照画像（受けた順） */
export function referencesWithoutGist(references: readonly ReferenceRecord[]): ReferenceRecord[] {
  return references.filter((reference) => reference.gist === undefined);
}

/**
 * carry に入れる参照画像の要点。要点のあるものから、新しい順に件数の上限まで取り、受けた順に並べる。
 */
// 全件を持ち回さない: 参照画像を添えるたびに入力が膨らむため。古い要点は refs/ にだけ残る
export function carriedReferences(
  references: readonly ReferenceRecord[],
  limits: ReferenceLimits,
): CarriedReference[] {
  const gisted = references.filter(
    (reference): reference is ReferenceRecord & { gist: string } => reference.gist !== undefined,
  );
  return gisted.slice(Math.max(0, gisted.length - limits.maxCount)).map((reference) => ({
    refId: reference.refId,
    gist: clipText(reference.gist, limits.gistChars).text,
  }));
}
