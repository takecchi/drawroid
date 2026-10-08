import { z } from 'zod';
import type { Budget } from './budget.js';

/** 考える役が決めてよいパラメータ。M2 の可動範囲（残りは M4 で足す） */
export const THINK_PARAM_KEYS = ['prompt', 'negativePrompt', 'seed', 'steps', 'cfg'] as const;
export type ThinkParamKey = (typeof THINK_PARAM_KEYS)[number];

export type ThinkParams = {
  prompt?: string;
  negativePrompt?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
};

function paramSchemas(budget: Budget) {
  return {
    prompt: z.string().min(1).max(budget.text.prompt),
    negativePrompt: z.string().max(budget.text.negativePrompt),
    // -1 はバックエンドに任せる（毎回ランダム）
    seed: z.number().int().min(-1).max(4294967295),
    steps: z.number().int().min(1).max(150),
    cfg: z.number().min(1).max(30),
  } satisfies Record<ThinkParamKey, z.ZodType>;
}

/**
 * 考える役の出力スキーマ。渡したパラメータだけを含む。
 */
// 全パラメータを含めて後で捨てる形にしない: 捨て忘れた瞬間に許可を迂回し、出力のトークンも無駄になるため
export function buildThinkOutputSchema(
  allowed: readonly ThinkParamKey[],
  budget: Budget,
): z.ZodType<ThinkOutput> {
  const all = paramSchemas(budget);
  const params: Partial<Record<ThinkParamKey, z.ZodType>> = {};
  for (const key of allowed) params[key] = all[key];
  // パラメータの集まりが実行時に決まり zod が型を推論できないので、出力の型は ThinkOutput として宣言する
  return z.object({
    params: z.object(params),
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
