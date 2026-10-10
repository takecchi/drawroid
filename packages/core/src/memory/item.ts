import { z } from 'zod';

export const MEMORY_SCOPES = ['always', 'tagged'] as const;
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryItemSchema = z.object({
  id: z.string().min(1),
  // 好みを短く書いたもの。長文の自由記述にしない（LLM に渡す量を予算で締められるように）
  body: z.string().min(1),
  tags: z.array(z.string()).default([]),
  scope: memoryScopeSchema,
  // どのジョブから学んだか
  sources: z.array(z.string()).default([]),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

/**
 * 記憶の ID の長さの上限（UTF-8 のバイト数）。ID は `<ID>.md` のファイル名になり、書くときは `.tmp-<12桁>-<ID>.md` を経るので、
 * その名前がファイル名の上限（255 バイト）に収まる長さ
 */
const MAX_MEMORY_ID_BYTES = 255 - '.tmp-'.length - 12 - '-'.length - '.md'.length;

/** 記憶の ID として使える形か。ID はそのままファイル名になるので、データディレクトリの外や一時ファイル・隠しファイルを指す形を通さない */
// 文字ではなくバイトで数える: ファイル名の上限はバイトで、日本語の ID は1文字が3バイトになるため
export function isMemoryId(id: string): boolean {
  return (
    id !== '' &&
    !id.startsWith('.') &&
    !/[/\\\0]/.test(id) &&
    new TextEncoder().encode(id).length <= MAX_MEMORY_ID_BYTES
  );
}
