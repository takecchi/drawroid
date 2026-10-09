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
