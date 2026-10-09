import { z } from 'zod';

import type { GenerationRequest } from '../backend.js';
import type { ParamKey } from '../params/param-key.js';
import type { ParamsSchema } from '../think/params-schema.js';

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
  options: { withInterventions?: boolean } = {},
): z.ZodType<ThinkOutput> {
  // パラメータの集まりが実行時に決まり zod が型を推論できないので、出力の型は ThinkOutput として宣言する
  // 文字数の上限を出力に付けない: 超えた出力を落とすとジョブが止まるため。入力に載せるときに予算で切るので、回を重ねても増えない
  const output = z.object({
    params: params.schema,
    rationale: z.string(),
  });
  // 口出しを載せた回だけ、統合した依頼の要点を出させる: 要点の更新のために専用の呼び出しを足さないため
  if (!options.withInterventions) return output as z.ZodType<ThinkOutput>;
  return output.extend({
    intent: z.string().min(1).describe('依頼の要点に、人間の指示を統合した新しい要点'),
  }) as z.ZodType<ThinkOutput>;
}

export type ThinkOutput = {
  params: ThinkParams;
  rationale: string;
  /** 口出しを載せた回だけある。依頼の要点に人間の指示を統合したもの */
  intent?: string;
};

/** 見る役の出力スキーマ。画像の枚数ぶんの評価をちょうど返させる */
export function buildJudgeOutputSchema(imageCount: number) {
  return z.object({
    images: z
      .array(
        z.object({
          /** 依頼の意図にどれだけ合っているか（0〜1） */
          score: z.number().min(0).max(1),
          issues: z.array(z.string()),
        }),
      )
      .length(imageCount),
    nextChange: z.string(),
    /** 意図どおりなので止めてよいか */
    canStop: z.boolean(),
  });
}

export type JudgeOutput = z.infer<ReturnType<typeof buildJudgeOutputSchema>>;
