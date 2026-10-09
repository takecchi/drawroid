import { z } from 'zod';

import { memoryScopeSchema, type MemoryScope } from '../item.js';
import type { DistillBudget } from './budget.js';

export type DistilledPreference = { body: string; tags: string[]; scope: MemoryScope };

/** 蒸留の出力の1操作。消す操作は無い（消すのは人間） */
export type DistillOperation =
  ({ op: 'add' } & DistilledPreference) | ({ op: 'edit'; id: string } & DistilledPreference);

export type DistillOutput = { operations: DistillOperation[] };

/**
 * 蒸留の出力スキーマ。直せる項目は、入力に載せた既存の項目だけに限る。
 */
// 項目を消す操作を置かない: AI が好みを消せると、人間の残した好みが気づかないうちに失われるため（architecture 初稿）
// scope の付け方をシステムプロンプトでなくスキーマの説明に置く: 機能を足すたびにプロンプトへ指示を足さないため
export function buildDistillOutputSchema(
  editableIds: readonly string[],
  budget: DistillBudget,
): z.ZodType<DistillOutput> {
  const preference = {
    body: z.string().min(1).max(budget.output.body).describe('好みを1つだけ、短く'),
    tags: z
      .array(z.string().min(1).max(budget.output.tag))
      .max(budget.output.tags)
      .describe('この好みが当てはまる依頼に現れる語（題材・画風など）'),
    scope: memoryScopeSchema.describe(
      '画質の禁止事項（指や顔の崩れ・破綻を許さない、など）は依頼によらず always。特定の題材・画風だけの好みは tagged',
    ),
  };
  const add = z.object({ op: z.literal('add'), ...preference });
  const [first, ...rest] = editableIds;
  const operation =
    first === undefined
      ? add
      : z.discriminatedUnion('op', [
          add,
          z.object({ op: z.literal('edit'), id: z.enum([first, ...rest]), ...preference }),
        ]);
  // 直せる項目が実行時に決まり zod が型を推論しきれないので、出力の型は DistillOutput として宣言する
  return z.object({
    operations: z.array(operation).max(budget.output.operations),
  }) as z.ZodType<DistillOutput>;
}
