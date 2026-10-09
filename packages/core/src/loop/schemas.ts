import { z } from 'zod';

import type { GenerationRequest } from '../backend.js';
import type { ParamKey } from '../params/param-key.js';
import type { ParamsSchema } from '../think/params-schema.js';
import type { Budget } from './budget.js';

/** 考える役が決めてよいパラメータのうち、M2 の可動範囲（残りは M4 で許可の設定から足す） */
export const THINK_PARAM_KEYS = [
  'prompt',
  'negativePrompt',
  'seed',
  'steps',
  'cfgScale',
] as const satisfies readonly ParamKey[];

export type ThinkParams = Partial<Omit<GenerationRequest, 'batchSize'>>;

/**
 * 考える役の出力スキーマ。パラメータの部分は、許可から組み立てたもの（buildParamsSchema）をそのまま使う。
 */
export function buildThinkOutputSchema(
  params: ParamsSchema,
  budget: Budget,
): z.ZodType<ThinkOutput> {
  // パラメータの集まりが実行時に決まり zod が型を推論できないので、出力の型は ThinkOutput として宣言する
  return z.object({
    params: params.schema,
    rationale: z.string().max(budget.text.rationale),
  }) as z.ZodType<ThinkOutput>;
}

export type ThinkOutput = {
  params: ThinkParams;
  rationale: string;
};

/** 見る役の出力スキーマ。画像の枚数ぶんの評価をちょうど返させる */
export function buildJudgeOutputSchema(imageCount: number, budget: Budget) {
  return z.object({
    images: z
      .array(
        z.object({
          /** 依頼の意図にどれだけ合っているか（0〜1） */
          score: z.number().min(0).max(1),
          issues: z.array(z.string().max(budget.text.issue)).max(budget.issuesPerImage),
        }),
      )
      .length(imageCount),
    nextChange: z.string().max(budget.text.nextChange),
    /** 意図どおりなので止めてよいか */
    canStop: z.boolean(),
  });
}

export type JudgeOutput = z.infer<ReturnType<typeof buildJudgeOutputSchema>>;
